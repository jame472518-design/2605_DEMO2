# demo2 — Strix Sensor Station

邊緣感測 + 即時 LLM 翻譯 + 視覺描述 + 手機觀看,Strix Halo 本地 AI demo 的其中一個。

**ESP32-S3-CAM** 5 顆 sensor + camera → WiFi → OpenClaw plugin 規則引擎 → 瀏覽器 / 手機 dashboard,異常時呼叫 qwen2:1.5b 寫中文解釋,觸發鏡頭就交給 qwen2.5vl:3b 描述場景。

> 姊妹 demo:**demo3** (Strix Studio · ComfyUI 消費級前端) 在獨立 repo,共用「Strix Halo 本地 AI + OpenClaw agent」故事。

---

## 從 0 開始安裝(Windows 11)

```powershell
# 1. 共用基礎
winget install OpenJS.NodeJS.LTS      # Node 20+
winget install pnpm.pnpm              # pnpm 套件管理(本 repo 全用 pnpm)
winget install Git.Git
winget install Mozilla.Firefox        # webcam getUserMedia 只在 Firefox 過

# 2. OpenClaw 平台(plugin runtime + gateway)
npm i -g openclaw@latest
openclaw onboard --install-daemon

# 3. Ollama(本地 LLM)
winget install Ollama.Ollama
# 重啟 shell 後拉兩個模型
ollama pull qwen2:1.5b                # judge agent(~1 GB)
ollama pull qwen2.5vl:3b              # vision agent(~3.2 GB)
```

韌體開發(只有要動 ESP32 才裝):
```powershell
winget install ArduinoSA.IDE                  # 或 PlatformIO
winget install --id Silabs.CP210xUSBdriver    # ESP32-S3-CAM 用的 USB driver
```

驗證:
```powershell
node -v   # v20+ 或 v22+
pnpm -v   # 10.x
ollama list   # 應該看到 qwen2:1.5b + qwen2.5vl:3b
```

---

## 一次性建置

```powershell
git clone https://github.com/jame472518-design/2605_DEMO2.git
cd 2605_DEMO2

# OpenClaw 環境準備
.\scripts\bootstrap-profile.ps1       # 建立 ~/.openclaw-strixdemo2/
.\scripts\install-workspaces.ps1      # 部署 judge-1 / vision-1 prompt workspace

# Build dashboard + plugin
cd dashboard;                          pnpm install; pnpm build
cd ..\openclaw-plugins\sensor-bridge;  pnpm install; pnpm build
cd ..\..

# 部署到 OpenClaw 設定資料夾
.\scripts\install-plugins.ps1
```

ESP32 韌體燒錄 + 接線 + WiFi secrets:見 `docs/WIRING-ESP32.md`。

---

## 啟動

### Booth(展場 — 全螢幕 kiosk)

```powershell
.\scripts\start-booth.ps1
```

自動做:
1. 起 OpenClaw gateway(`:18790`)
2. 起 HTTPS proxy(`:18443`,給手機掃 QR 用)
3. 背景預熱 `qwen2.5vl:3b` VLM
4. **開 Firefox kiosk 全螢幕**指向 dashboard

**沒有 ESP32 也能跑** — 右下角 INGEST widget 預設 AUTO,沒收到硬體 frame 就自動切 mock 合成資料,sensor 卡會立刻有數值跑、alert 也會週期觸發。

**停止**:`.\scripts\stop-demo.ps1`

**離開 kiosk**:focus Firefox → `Alt+F4`

### 正常視窗(開發 — 有網址欄、taskbar)

```powershell
.\scripts\start-demo.ps1 -NoBrowser

# 另外開正常 Firefox
$token = (Get-Content .env.local | Where-Object { $_ -match "^OPENCLAW_GATEWAY_TOKEN=" }) -replace "^OPENCLAW_GATEWAY_TOKEN=",""
& 'C:\Program Files\Mozilla Firefox\firefox.exe' "http://127.0.0.1:18790/?token=$token"
```

### Mock 模式(完全沒 ESP32 / Python bridge)

```powershell
.\scripts\start-demo.ps1 -Mock
.\scripts\start-demo.ps1 -Mock -ForceHeat   # 5s 後強觸發 heat_sustained
```

(W6 之後 plugin 本身有 mock generator,`-Mock` python bridge 漸漸不需要 — 用 booth 起來右下切 MOCK 即可。)

---

## 截圖預覽(不用啟動 server)

```
sensorstation-preview.html
```

雙擊任意瀏覽器開,**完全不需要安裝**(Tailwind + 字型走 CDN)。內含 4 個 dashboard 狀態:LIVE / CRITICAL / VLM CHAT / MOBILE PUSH。給截圖、簡報、提案用。

---

## 架構

```
ESP32-S3-CAM
   ├─ DHT11 / PIR / HC-SR04 / INMP441 mic / OV2640 camera @ 1Hz
   ├─ Servo pan + tilt / Buzzer / LED
   │ HTTP POST sensor frame + Bearer token        (over WiFi 2.4GHz)
   │ MJPEG @ :81/stream                            (browser <img>)
   │ ◀── HTTP /cmd  (actuator: buzzer / LED / servo)
   ▼
OpenClaw plugin · sensor-bridge
   ├─ rules.ts(規則引擎,毫秒級 — heat_sustained / motion_detected /
   │           noise_event / object_too_close)
   ├─ mockFrames.ts(W6:沒 ESP32 時自動產合成 frame)
   ├─ judge-1 agent · qwen2:1.5b(異常觸發中文 enrichment)
   ├─ vision-1 agent · qwen2.5vl:3b(auto_vision rule 觸發場景描述)
   ├─ /api/vlm/chat(W6:NDJSON 串流給 dashboard 的 VLM 對話頁)
   ├─ /api/dev/mock(W6:AUTO / FORCE MOCK / OFF 切換)
   ├─ SSE × 2:/api/sensor/stream + /api/alert/stream
   └─ /api/esp32/{capture,stream}(反代 ESP32,避手機 HTTPS 混合內容)
   ▼
Dashboard SPA(Vite + React + Tailwind · Strix Tactical HUD v2)
   ├─ Header + telemetry strip + breadcrumb + epoch clock
   ├─ AlertBanner + #INC- incident codes + ◯/⚠/⛔ glyphs
   ├─ CameraCard with HUD overlay(corner brackets, T+timer,bitrate)
   ├─ 5× SensorCard(NOMINAL / WATCH / ARMED / TRIP 4-state machine,
   │   sparkline gradient, Δ rate-of-change, digit ticker)
   ├─ AGENT LOG(折疊式 entry + agent-thinking + vision-thinking)
   ├─ ActuatorControls(servo arc gauge + breadcrumb)
   ├─ MockController(右下浮動,3 模式切換)
   ├─ QrPanel(右下 QR,給訪客掃進手機)
   ├─ AlertPushBanner(觸控裝置才出現的 iOS push 風橫條 + 震動 + 蜂鳴)
   └─ VlmChat(#/vlm:image upload + 串流多模態對話)
```

---

## 操作面板

### 切換 mock / 真實 ESP32
Dashboard 右下角 **INGEST** 浮動 widget:
- **AUTO**(預設)— 有 ESP32 用真資料,沒就 mock
- **MOCK** — 強制 mock(展示用,故事感最強)
- **OFF** — 不 mock,沒 ESP32 就空畫面

### 手機端
Dashboard 右下角 QR → 手機掃 → 自動走 HTTPS proxy `:18443` 連同畫面。
- 任何 alert 觸發 → iOS push 風橫條 + **震動** + **蜂鳴**(6 秒倒數)
- 嚴重度配色:info=青、warn=黃、critical=紅

### VLM 對話
Dashboard header 右上 **[VLM]** chip → 切到 `#/vlm` → 拖一張圖 + 文字 prompt → NDJSON 串流多模態對話。

---

## Repo 架構

```
demo2/
├─ README.md                                  ← 本文件
├─ arduino/esp32_sensor_node/                 ESP32 韌體(C++/Arduino)
│  └─ docs/(腳位設定截圖等)
├─ dashboard/                                 SPA(Vite + React + Tailwind)
│  ├─ src/App.tsx                             Hash-route(dashboard / #/vlm)
│  ├─ src/components/                         SensorCard / CameraCard / AlertBanner …
│  └─ src/lib/                                api.ts / sse.ts / gatewayToken.ts
├─ openclaw-plugins/sensor-bridge/            OpenClaw plugin(TypeScript)
│  ├─ src/index.ts                            HTTP routes、ingest pipeline
│  ├─ src/rules.ts                            規則引擎
│  ├─ src/mockFrames.ts                       Mock 合成 frame 產生器
│  ├─ src/judge.ts / vision.ts                Ollama 客戶端
│  └─ rules.yaml                              規則設定
├─ scripts/                                   PowerShell 啟動 / 停止 / 部署
├─ tools/https-proxy/                         :18443 → :18790 反代(給手機)
├─ report/                                    一頁式商業報告 (HTML)
├─ sensorstation-preview.html                 單檔 HTML 截圖預覽
└─ docs/                                      架構 / 接線 / 操作手冊
   ├─ ARCHITECTURE.md
   ├─ PLAN.md
   ├─ README-OPERATIONS.md
   ├─ WIRING-ESP32.md
   └─ WIRING.md
```

---

## 開發筆記

- **commit identity**:repo-local `james / james472518@gmail.com`(非全域)
- **build artifacts**:`dashboard/dist/` 跟 `openclaw-plugins/*/dist/` 要 rebuild 才生效。改完前端 / plugin 跑 `pnpm build` + `install-plugins.ps1` 才會被 gateway 載到
- **Hot reload**:dashboard 可 `pnpm dev`(localhost:5173,不走 gateway)。Plugin 沒 HMR,改完要 stop-demo + rebuild + install + restart
- **profile 隔離**:所有 openclaw 指令 `--profile strixdemo2`,不污染你個人 `~/.openclaw/`

---

## 故障排除

| 症狀 | 通常原因 / 解法 |
|---|---|
| `start-booth.ps1` 報 `Port 18790 already in use` | 上次沒乾淨關。`.\scripts\stop-demo.ps1` 再試 |
| Firefox 開了但 dashboard 空白 | Token 不對 / gateway 還沒 ready。等 3 秒 Ctrl+R |
| Sensor 卡都顯示 "—" | INGEST widget 是不是切到 OFF?切回 AUTO 或 MOCK |
| `qwen2.5vl:3b` SCAN 第一次很慢(>30s) | 10GB VLM 冷啟動。第一次後 keep_alive 10 分鐘,booth 期間都熱的 |
| 手機掃 QR 無法連 | HTTPS proxy 沒起來。檢查 `:18443` 是否在 listen |
| 手機 SCAN 沒畫面 | Android Chrome mixed-content 擋的,改用手機 Firefox |
| ESP32 連不上 dashboard | `arduino/esp32_sensor_node/secrets.h` WiFi / token 設定 |

---

## 里程碑

```
w1-rule-spine                    規則骨幹 + 5 sensor card + Vitest
w2-judge-enrichment              qwen2:1.5b 中文 enrichment + YAML rules
w3-esp32-prep                    ESP32-S3-CAM 韌體 + Camera card
w4-jetson-transition             Linux deploy + bash scripts
w5.1-webcam-vision               qwen2.5vl:3b 視覺描述 agent
w5.2-phase1                      Arduino DHT + servos + OLED + 麥克風
w5.3-servo-and-esp32-scan        Servo pan/tilt + ESP32 SCAN 鈕
w5.4-booth-ops                   Firefox kiosk + QR + HTTPS proxy
w5.5-phase2-and-audio-vision     audio-event auto-vision + bug 收尾

(W6 系列尚未打 tag,head 為 main)
W6:   VLM chat page + mock fallback + 手機 push alerts
W6.1: 鏡頭 codenames(IRIS-01 / LENS-NN)+ Strix Tactical HUD v2 視覺 refresh
```

---

最後更新 · 2026-05-28
