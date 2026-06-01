# SOP — demo2 安裝 / 重灌 / 更新指南

**對象**:新機器、想砍掉重來的舊機器、要把 demo2 同步到另一台。

**先決條件**:Windows 10/11 64-bit、~10GB 磁碟、8GB+ RAM、WiFi/Ethernet、Webcam(或 ESP32-S3-CAM)。

---

## A. 工具安裝(只要一次,以後就略過)

### A.1 PowerShell 解除腳本限制

**必做!** Windows 預設 `Restricted` 擋所有 `.ps1`。

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
# 跳出 Y/N 選 Y。不需要管理員。
```

### A.2 winget 一次裝齊

```powershell
winget install OpenJS.NodeJS.LTS     # Node 20+
winget install pnpm.pnpm              # pnpm
winget install Git.Git                # 版控
winget install Mozilla.Firefox        # webcam 只在 Firefox 過
winget install Ollama.Ollama          # 本地 LLM
```

### A.3 OpenClaw daemon

```powershell
# 重開 PowerShell 後跑(讓 npm PATH 生效)
npm i -g openclaw@latest
openclaw onboard --install-daemon
```

### A.4 拉模型(~5GB,只下載一次)

```powershell
ollama pull qwen2:1.5b       # judge(中文事件解釋)
ollama pull qwen2.5vl:3b     # vision(場景描述 + VLM 對話)
ollama list                   # 確認兩個都在
```

### A.5(選用)讓 LAN 別台也能連 Ollama

只有要 Surface 用 Halo 的 Ollama 才需要:

```powershell
[System.Environment]::SetEnvironmentVariable("OLLAMA_HOST", "0.0.0.0:11434", "User")
# 重啟 Ollama:系統匣 Quit → 開始選單重開
```

---

## B. 安裝 demo2(從 0 開始 / 砍掉重來)

### B.1 砍乾淨(已有舊版才需要)

```powershell
# 在原本放 repo 的上一層目錄
cd C:\Users\user\Desktop\project    # 改成你的路徑

# 停掉跑中的服務
.\2605_DEMO2\scripts\stop-demo.ps1 -ErrorAction SilentlyContinue
Get-Process firefox -ErrorAction SilentlyContinue | Stop-Process -Force

# 砍 repo + OpenClaw profile(token 會重新產)
Remove-Item -Recurse -Force 2605_DEMO2 -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $env:USERPROFILE\.openclaw-strixdemo2 -ErrorAction SilentlyContinue
```

**會留下不會砍**:Ollama 本體 + 模型(`~/.ollama/models/`)、Node / pnpm / git / Firefox、OLLAMA_HOST env。

### B.2 Clone + 建置

```powershell
git clone https://github.com/jame472518-design/2605_DEMO2.git
cd 2605_DEMO2

# OpenClaw profile 初始化(會自動產 .env.local 跟 token)
.\scripts\bootstrap-profile.ps1
.\scripts\install-workspaces.ps1

# Build dashboard + plugin(各 ~30-60 秒)
cd dashboard
pnpm install
pnpm build
cd ..\openclaw-plugins\sensor-bridge
pnpm install
pnpm build
cd ..\..

# 部署 + 啟動
.\scripts\install-plugins.ps1
.\scripts\start-booth.ps1 -Dev
```

**B.1 + B.2 總時間**:約 **5-10 分鐘**(看網速)。

---

## C. 平常更新(已裝過,只想拉新 commit)

```powershell
cd C:\Users\user\Desktop\project\2605_DEMO2

git pull

# 改動範圍可能涵蓋兩邊,保險全 build
cd dashboard
pnpm install
pnpm build
cd ..\openclaw-plugins\sensor-bridge
pnpm install
pnpm build
cd ..\..

.\scripts\install-plugins.ps1
.\scripts\stop-demo.ps1
.\scripts\start-booth.ps1 -Dev
```

如果只動了 dashboard:`cd dashboard; pnpm build; cd ..` 後接 install-plugins + restart 即可。
如果只動了 plugin:`cd openclaw-plugins\sensor-bridge; pnpm build; cd ..\..` 後接 install-plugins + restart。

---

## D. 啟動 / 停止

| 用途 | 指令 |
|---|---|
| 展場 kiosk(全螢幕) | `.\scripts\start-booth.ps1` |
| 開發(正常視窗,看得到網址) | `.\scripts\start-booth.ps1 -Dev` |
| Mock 模式(不接 ESP32) | `.\scripts\start-booth.ps1 -Dev -Mock` |
| 停止全部 | `.\scripts\stop-demo.ps1` |
| 離開 kiosk Firefox | focus Firefox → `Alt+F4` |

---

## E. 驗證

啟動後 Firefox 應自動開新視窗,**看到**:

- 上方 telemetry strip + breadcrumb
- 左欄:鏡頭區(若無 ESP32,顯示「等待 IRIS-01 連線」或可切換 LENS webcam)
- 右欄:**VISION-1** 面板(預設「NO SCAN YET」)
- 鏡頭右上 3 顆按鈕:`◯ AUTO` · `👁 SCAN` · `⏸ PAUSE`
- 5 張 sensor 卡 + AGENT LOG + ActuatorControls
- 右下浮動 INGEST 開關 + QR

**測試 SCAN**:點 `👁 SCAN` → 鏡頭下方瞬間「agent 分析中…」→ 3-10 秒後右邊 VISION-1 跳出 60-100 字中文場景描述。

---

## F. 切換 / 換模型(換 gemma 之類)

只改 `demo2/demo.config.ps1`:

```powershell
$DEMO2_JUDGE_MODEL  = "qwen2:1.5b"    # 換成你 ollama pull 的模型
$DEMO2_VISION_MODEL = "qwen2.5vl:3b"
$DEMO2_VLM_MODEL    = "qwen2.5vl:3b"
$DEMO2_OLLAMA_URL   = "http://127.0.0.1:11434"   # 換到別台 Halo 改 IP
```

```powershell
ollama pull <新模型>            # 先確認模型在
.\scripts\stop-demo.ps1
.\scripts\start-booth.ps1 -Dev   # 重啟即生效,不用重 build
```

---

## G. 常見問題

### G.1 Firefox 開出來是 **OpenClaw 黑色預設頁**(不是 dashboard)

**原因**:plugin 載入失敗 — 最常見是 yaml dep 沒裝進 plugin 目錄。
**解法**:重跑 `.\scripts\install-plugins.ps1`(現在會自動 `npm install --omit=dev` 補)。

### G.2 PowerShell 報 `cannot be loaded because running scripts is disabled`

**解法**:A.1 那條 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`。

### G.3 `pnpm install` 報 `ERR_PNPM_IGNORED_BUILDS esbuild`

**解法**:`pnpm approve-builds` 互動式選 esbuild。或 `git pull` 拉新版(`.npmrc` 已 whitelist)。

### G.4 SSH 進機器後跑 `start-booth.ps1`,桌面看不到 Firefox

**原因**:SSH 跑在 Windows **session 0**(服務 session),桌面在 **session 1**。
**解法**:**直接在那台機器的桌面 PowerShell 跑**,不要 SSH。SSH 只適合做後端命令(`git pull` / `pnpm build` / 看 log)。

### G.5 別台連不到本機 Ollama `:11434`

**原因**:Ollama 預設只 listen `127.0.0.1`。
**解法**:A.5 那段,設 `OLLAMA_HOST=0.0.0.0:11434` + 重啟 Ollama + 防火牆開 `:11434`。

### G.6 SCAN 顯示「無法擷取畫面:camera 503」

**原因**:沒接 ESP32(IRIS-01)。
**解法**:CameraCard 上方切到 **LENS-01 / FRONT / REAR**(webcam)即可。

### G.7 `New-NetFirewallRule` 報權限不足

**解法**:右鍵 PowerShell → **以系統管理員身份執行**。防火牆規則要 admin。

### G.8 `start-booth.ps1` 報 `Port 18790 already in use`

**解法**:`.\scripts\stop-demo.ps1` 再 start。

### G.9 第一次 SCAN 非常慢(>30 秒)

**正常**:qwen2.5vl:3b 冷啟動載 ~10GB 到記憶體要時間。**之後 `keep_alive: "10m"` 撐著**,連續 SCAN 都會很快(Halo 上 3-5 秒,Surface CPU 上 ~25 秒)。

### G.10 dashboard 看不到「新版的兩欄」/「綠色人臉框」/「60-100 字描述」

**原因**:bundle / plugin 沒重 deploy。
**解法**:C 那段「平常更新」流程跑完整,**含 `install-plugins.ps1` + `stop-demo` + `start-booth`**。

---

## H. 給訪客手機 / 別台用(不裝任何東西)

booth 開好後:

1. dashboard 右下 QR 給訪客掃,自動連到 LAN URL(走 HTTPS proxy `:18443`)
2. 或別台電腦瀏覽器直接打:`http://<booth-ip>:18790/?token=<token>`
   - IP:在 booth 上跑 `ipconfig` 看
   - Token:在 booth 的 `.env.local` 裡

防火牆要 `:18790` 跟 `:18443` 兩個 inbound 都開(`scripts/start-booth.ps1` 不會自動開,要自己一次)。

---

## I. 連 demo3 / Strix Studio?

**不在這份 SOP 範圍**。demo3 是 ComfyUI 消費級前端的 mock 預覽版,獨立目錄、獨立流程,看 demo3 自己的 README。

---

最後更新 · 2026-06-01 · build `4db7829` 之後(install-plugins 改用 npm install + ASCII-only .ps1 + 全項 face tracking + 60-100 字 vision prompt)
