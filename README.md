# demo2 — Strix Halo AI Sensor Station

輕量版多 sensor 監測 demo。**ESP32-S3-CAM** 4 顆 sensor + camera → WiFi → OpenClaw plugin 規則引擎 → 瀏覽器/手機 dashboard,只在異常時呼叫小 LLM 寫一句中文解釋。

對比 demo1:demo1 是多 agent chat showcase(吃 RAM),demo2 是低 RAM 規則決策 demo,LLM 不在 live loop。

## 架構

```
ESP32-S3-CAM (DHT11 + PIR + LDR + HC-SR04 @1Hz, OV2640 camera)
   │ HTTP POST JSON + Bearer token   (over WiFi 2.4GHz)
   │ MJPEG @ :81/stream              (browser <img>)
   ▼
OpenClaw plugin: sensor-bridge
   │  ├─ rules.ts (規則引擎,毫秒級)
   │  ├─ judge-1 agent (qwen2:1.5b,只在異常觸發,中文 enrichment)
   │  ├─ SSE × 2:/api/sensor/stream + /api/alert/stream
   │  └─ /api/device-info(dashboard 拿 ESP32 IP 接 camera)
   ▼
Dashboard SPA(5 sensor cards + camera card + alert + judge log + actuator,RWD)
   │
   └─ 反控指令 → plugin → ESP32 :80/cmd → buzzer/LED
```

## 快速跑

**第一次設定**(只跑一次):

```powershell
cd demo2
pnpm install -r                     # plugin + dashboard
.\scripts\bootstrap-profile.ps1     # 寫 ~/.openclaw-strixdemo2/openclaw.json
.\scripts\install-workspaces.ps1    # 註冊 judge-1
cd dashboard; pnpm run build; cd ..
.\scripts\install-plugins.ps1       # plugin + SPA + judge-prompt → ~/.openclaw-strixdemo2/extensions/
ollama pull qwen2:1.5b              # ~1GB(不拉 alert 還是會 fire,只是沒中文 enrichment)
```

ESP32 韌體燒錄 + 接線 + secrets:見 `docs/WIRING-ESP32.md`。

**每次跑 demo**:

```powershell
# 預設:ESP32 模式(ESP32 自己連 WiFi 會打進來,PC 只起 gateway + browser)
.\scripts\start-demo.ps1

# 沒硬體:用 Python mock 假資料(需要 Python + pip install -r bridge\requirements.txt)
.\scripts\start-demo.ps1 -Mock
.\scripts\start-demo.ps1 -Mock -ForceHeat   # 5s 後強觸發 heat_sustained

# Edge --app 模式(像獨立 app,booth demo 用)
.\scripts\start-demo.ps1 -Edge

# 停
.\scripts\stop-demo.ps1
```

`start-demo.ps1` 會在獨立 PS 視窗起 gateway,方便看 log(`judge enriched ...` 行最關鍵)。

開瀏覽器 `http://127.0.0.1:18790/?token=...`(token 從 `.env.local` 讀,launcher 自動帶)。

> demo1 預設用 18789;demo2 用 **18790**,兩個可以同時跑互不干擾。

## ESP32 vs Mock 兩種模式

| | ESP32 (預設) | Mock (`-Mock`) |
|---|---|---|
| 何時用 | booth 正式 demo | 沒硬體 / dev iteration |
| 資料來源 | ESP32-S3-CAM WiFi POST | Python `mock_serial.py` 合成 |
| 需要 Python? | 否 | 是(`pip install -r bridge\requirements.txt`)|
| Camera card | 有(MJPEG live)| 顯示「等待 ESP32 連線」|
| Actuator(buzzer/LED)| 真的響/亮 | log 而已 |

## 重要原則

- **Live loop 零 LLM、毫秒級**:規則引擎 in-plugin,每秒處理 frame
- **Agent per-event spawn**:qwen2:1.5b ~1.5GB,只在 fire 時呼叫,不常駐
- **單頁 RWD**:Android 同 LAN 同網址直開
- **單一 SQLite**(暫停用 — bridge.py 還是有寫,生產用 ESP32 後沒有 SQLite 路徑)
- **Profile 隔離**:所有 openclaw 指令 `--profile strixdemo2`,不污染你個人 `~/.openclaw/`

## 文件

- `docs/PLAN.md` — 完整實作計畫(W1/W2/W3 milestones)
- `docs/ARCHITECTURE.md` — 架構摘要
- `docs/WIRING-ESP32.md` — **ESP32-S3-CAM 接線、BOM、燒錄步驟**
- `docs/WIRING.md` — Arduino Uno 版接線(legacy 參考用)

## 里程碑

```
w1-rule-spine       規則骨幹(5 sensor card、AlertBanner、JudgePanel、ActuatorControls)
w2-judge-enrichment qwen2:1.5b 中文 enrichment + Vitest 12/12 + YAML rules
w3-esp32-prep       ESP32-S3-CAM 韌體 + Camera card + 拿掉 Python 生產相依
```
