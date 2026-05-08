# demo2 — Strix Halo AI Sensor Station

輕量版多 sensor 監測 demo。Arduino 4 顆 sensor → Python bridge → OpenClaw plugin 規則引擎 → 瀏覽器/手機 dashboard,只在異常時呼叫小 LLM 寫一句中文解釋。

對比 demo1:demo1 是多 agent chat showcase(吃 RAM),demo2 是低 RAM 規則決策 demo,LLM 不在 live loop。

## 架構

```
Arduino (DHT22 + PIR + 光感 + HC-SR04 @1Hz)
   │ serial CSV
   ▼
Python bridge ──HTTP──▶ OpenClaw plugin: sensor-bridge
   ▲                       │  ├─ rules.ts (規則引擎,毫秒級)
   │ /cmd                   │  ├─ judge-1 agent (qwen2:1.5b,只在異常觸發)
   └─ 反控 buzzer/LED ◀───┤  └─ SSE × 2:/api/sensor/stream + /api/alert/stream
                            ▼
                    Dashboard SPA(桌機 4 欄、手機 1 欄,LAN 可看)
```

## 快速跑(mock 模式,沒 Arduino 也可)

```powershell
# 1. 安裝依賴
cd demo2
pnpm install -r                     # plugin + dashboard
pip install -r bridge\requirements.txt

# 2. Bootstrap + 安裝 plugin + 註冊 agent
.\scripts\bootstrap-profile.ps1     # 寫 ~/.openclaw-strixdemo2/openclaw.json
.\scripts\install-workspaces.ps1    # 註冊 judge-1 進 agents.list
cd dashboard; pnpm run build; cd .. # build SPA(plugin install 會帶進去)
.\scripts\install-plugins.ps1       # 複製 plugin + SPA + judge-prompt 到 ~/.openclaw-strixdemo2/extensions/

# 3.(選做)拉 LLM 模型 — 沒拉就跳過,alert 還是會 fire 只是沒中文 explanation
ollama pull qwen2:1.5b              # ~1GB

# 4. 起 mock 模式
.\scripts\run-mock.ps1              # mock 模式;加 -ForceHeat 強制觸發 heat_sustained
```

開瀏覽器 `http://127.0.0.1:18790/?token=...`(token 從 `.env.local` 讀)。

> demo1 預設用 18789;demo2 用 **18790**,兩個可以同時跑互不干擾。

## 真 Arduino 模式

接好線(見 `docs/WIRING.md`),燒 `arduino/sensor_station/sensor_station.ino`,跑:

```powershell
.\scripts\run-bridge.ps1 -Port COM3
```

## 重要原則

- Live loop 零 LLM、毫秒級
- 模型上限 ~1.5GB(qwen2:1.5b),且 per-event spawn 不常駐
- 單頁 RWD,Android 同網址直開
- 單一 SQLite 檔做歷史

## 對應計畫

- `docs/PLAN.md` — 完整實作計畫(W1/W2 milestones、wire schemas、不做清單)
- `docs/ARCHITECTURE.md` — 現在實際在跑的架構摘要
- `docs/WIRING.md` — Arduino 接線圖
