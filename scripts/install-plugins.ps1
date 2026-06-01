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
        # Compare dist/index.js mtime against the NEWEST file under src/**.
        # The previous check only looked at src/index.ts, so edits to other
        # source files (vision.ts, judge.ts, rules.ts, mockFrames.ts...) were
        # silently treated as "dist up-to-date" and never re-compiled.
        $distFile = "dist\index.js"
        $needsBuild = -not (Test-Path $distFile)
        if (-not $needsBuild) {
            $distMtime = (Get-Item $distFile).LastWriteTime
            $newestSrc = Get-ChildItem "src" -Recurse -File -Filter "*.ts" -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1
            if ($newestSrc -and $newestSrc.LastWriteTime -gt $distMtime) { $needsBuild = $true }
        }
        if ($needsBuild) {
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

    # Runtime dependencies: just run `npm install --omit=dev` IN the install
    # dir using the package.json we just copied. This gets us a clean flat
    # node_modules without the pnpm symlink/junction hell that crippled the
    # previous Copy-Item / robocopy approach (Windows 11 "untrusted mount
    # point" blocked traversing pnpm's symlinks to the central store, so deps
    # like `yaml` silently got skipped and the plugin failed to load with
    # MODULE_NOT_FOUND).
    $pkg = Get-Content "$($p.FullName)\package.json" -Raw | ConvertFrom-Json
    $hasRuntimeDeps = $pkg.PSObject.Properties.Match('dependencies').Count -gt 0 -and $pkg.dependencies -and ($pkg.dependencies.PSObject.Properties.Name.Count -gt 0)
    if ($hasRuntimeDeps) {
        Write-Host "[$($p.Name)] installing runtime deps via npm in $dst..."
        Push-Location $dst
        try {
            $null = npm install --omit=dev --no-audit --no-fund --no-package-lock --silent 2>&1
            if ($LASTEXITCODE -ne 0) {
                Write-Warning "  npm install exit $LASTEXITCODE - plugin may fail to load if a dep is missing"
            } else {
                $installedCount = (Get-ChildItem "node_modules" -Directory -ErrorAction SilentlyContinue | Measure-Object).Count
                Write-Host "[$($p.Name)] installed $installedCount runtime dep(s) -> node_modules/"
            }
        } finally {
            Pop-Location
        }
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
