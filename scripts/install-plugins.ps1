param(
    [string]$Profile = ""
)
$ErrorActionPreference = "Stop"

# Single source of truth for profile - edit demo.config.ps1. An explicit
# -Profile arg still overrides it.
. "$PSScriptRoot\..\demo.config.ps1"
if (-not $Profile) { $Profile = $DEMO2_PROFILE }

$pluginsRoot = Resolve-Path "$PSScriptRoot\..\openclaw-plugins"
$installRoot = Join-Path $env:USERPROFILE ".openclaw-$Profile\extensions"
New-Item -ItemType Directory -Force -Path $installRoot | Out-Null

$plugins = Get-ChildItem $pluginsRoot -Directory
foreach ($p in $plugins) {
    Write-Host "[$($p.Name)] building..."
    Push-Location $p.FullName
    try {
        if (-not (Test-Path "dist\index.js") -or ((Get-Item "src\index.ts").LastWriteTime -gt (Get-Item "dist\index.js" -ErrorAction SilentlyContinue).LastWriteTime)) {
            pnpm run build
        } else {
            Write-Host "[$($p.Name)] dist is up-to-date, skipping build"
        }
    } finally {
        Pop-Location
    }
    $dst = Join-Path $installRoot $p.Name
    if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
    Copy-Item -Recurse -Force "$($p.FullName)\dist" $dst
    Copy-Item -Force "$($p.FullName)\package.json" $dst
    Copy-Item -Force "$($p.FullName)\openclaw.plugin.json" $dst
    # rules.yaml: ship alongside the plugin so plugin can locate it at runtime.
    if (Test-Path "$($p.FullName)\rules.yaml") {
        Copy-Item -Force "$($p.FullName)\rules.yaml" $dst
    }
    # judge-prompt / vision-prompt: copy SOUL.md + AGENTS.md from each agent
    # workspace into the sensor-bridge plugin install dir so judge.ts /
    # vision.ts can read them as system prompts at startup. (Only sensor-bridge
    # needs these.)
    if ($p.Name -eq "sensor-bridge") {
        foreach ($pair in @(
            @{ id = "judge-1"  ; dstName = "judge-prompt"  },
            @{ id = "vision-1" ; dstName = "vision-prompt" }
        )) {
            $wsPath = Resolve-Path "$PSScriptRoot\..\openclaw-workspaces\$($pair.id)" -ErrorAction SilentlyContinue
            if ($wsPath) {
                $promptDst = Join-Path $dst $pair.dstName
                New-Item -ItemType Directory -Force -Path $promptDst | Out-Null
                foreach ($f in @("SOUL.md", "AGENTS.md")) {
                    $src = Join-Path $wsPath $f
                    if (Test-Path $src) { Copy-Item -Force $src $promptDst }
                }
                Write-Host "[$($p.Name)] copied $($pair.id) prompt -> $promptDst"
            }
        }
    }

    # Ship runtime dependencies (production deps only).
    $pkg = Get-Content "$($p.FullName)\package.json" -Raw | ConvertFrom-Json
    $runtimeDeps = @()
    if ($pkg.PSObject.Properties.Match('dependencies').Count -gt 0 -and $pkg.dependencies) {
        $runtimeDeps = $pkg.dependencies.PSObject.Properties.Name
    }
    if ($runtimeDeps.Count -gt 0) {
        $copied = @{}
        function Copy-Dep([string]$depName, [string]$srcRoot, [string]$dstRoot) {
            if ($script:copied.ContainsKey($depName)) { return }
            $script:copied[$depName] = $true
            $depSrc = Join-Path $srcRoot "node_modules\$depName"
            if (-not (Test-Path $depSrc)) {
                Write-Warning "  runtime dep '$depName' not found at $depSrc - skipping"
                return
            }
            $depDst = Join-Path $dstRoot "node_modules\$depName"
            New-Item -ItemType Directory -Force -Path (Split-Path $depDst -Parent) | Out-Null
            Copy-Item -Recurse -Force $depSrc $depDst
            $depPkgPath = Join-Path $depSrc "package.json"
            if (Test-Path $depPkgPath) {
                $depPkg = Get-Content $depPkgPath -Raw | ConvertFrom-Json
                if ($depPkg.PSObject.Properties.Match('dependencies').Count -gt 0 -and $depPkg.dependencies) {
                    foreach ($subDep in $depPkg.dependencies.PSObject.Properties.Name) {
                        Copy-Dep $subDep $srcRoot $dstRoot
                    }
                }
            }
        }
        $script:copied = @{}
        foreach ($d in $runtimeDeps) { Copy-Dep $d $p.FullName $dst }
        Write-Host "[$($p.Name)] copied $($script:copied.Count) runtime dep(s) -> node_modules/"
    }

    Write-Host "[$($p.Name)] installed -> $dst"

    # sensor-bridge hosts the dashboard SPA at /static/. If dashboard/dist exists,
    # copy it in. Without this the SPA would 404.
    if ($p.Name -eq "sensor-bridge") {
        $dashboardDist = Resolve-Path "$PSScriptRoot\..\dashboard\dist" -ErrorAction SilentlyContinue
        if ($dashboardDist) {
            $staticDst = Join-Path $dst "static"
            New-Item -ItemType Directory -Force -Path $staticDst | Out-Null
            Copy-Item -Recurse -Force "$dashboardDist\*" $staticDst
            Write-Host "[$($p.Name)] copied dashboard SPA bundle -> $staticDst"
        } else {
            Write-Host "[$($p.Name)] no dashboard/dist found - run 'cd dashboard; pnpm run build' then re-run this script"
        }
    }
}
Write-Host ""
Write-Host "Done. Profile '$Profile' plugins installed at $installRoot"
