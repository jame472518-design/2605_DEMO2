<!--
  原始實作計畫(Plan mode 寫於 2026-05-08)。
  此檔為歷史性文件,記錄當時跟使用者對齊的方案。
  「現在實際在跑的架構」請看 docs/ARCHITECTURE.md。
  小落差(W1 已知):
   - port 從 18789 改成 18790(demo1 已用 18789)
   - 5 個 SensorCard 實例(原計畫寫 4,實作時把 DHT22 拆 temp+humidity 兩張卡)
   - Plugin 用 OpenClaw SDK 的 registerHttpRoute(不是 Fastify)
-->

# demo2 — Strix Halo "AI Sensor Station" 實作計畫

## Context

demo1 是 Strix Halo 硬體 showcase + 多 agent chat,完整跑起來但吃 RAM 重(Ollama llama3.2 ~7GB,Snapdragon X 開發機 15.6GB RAM 必須把 KV cache 砍到 8192,且首次 chat 容易 timeout)。**demo2 要做的是反向**:把 OpenClaw 當成 plugin host + 簡單決策引擎,中間 90% 工作交給規則引擎(零 LLM RAM、毫秒回應),agent 只在「異常需要解釋」時偶發呼叫,模型換成 qwen2:1.5b(~1.5GB,只在事件觸發時 spawn)。

故事線:Arduino 接 DHT22 + PIR + 光感 + 超音波 4 個 sensor → Python 透過 serial + SQLite 中介 → OpenClaw plugin 廣播 SSE 到瀏覽器/手機 dashboard、跑規則引擎、異常時請小 agent 寫一句中文解釋 + 反向送 buzzer/LED 指令給 Arduino。

放在 `demo2/`,自己的 git repo(跟 demo1 平行,不互相依賴)。

---

## Architecture

### Data flow

```
                                          ┌────── SSE /api/sensor/stream ──→ Dashboard SPA (4 sensor cards)
Arduino (DHT22+PIR+lux+HC-SR04 @1Hz)      │                                      │
    │ serial CSV "seq,temp,hum,pir,lux,d" │                                      │ Tailwind RWD
    ▼                                      │                                      │ → Android 同 LAN 同網址
Python bridge (pyserial + SQLite + HTTP) ──┤                                      │
    ▲ POST /cmd (BUZZER/LED)               │                                      │
    │                                      ▼                                      ▼
    │                        OpenClaw plugin: sensor-bridge                   AlertBanner
    │                            ├── rules.ts (YAML config)                       ▲
    │                            ├── on rule fire ──┬─→ alert_v1 SSE ─────────────┤
    │                            │                  ├─→ POST /cmd actuator ───────┘ (反控回 Arduino)
    │                            │                  └─→ async judge.run() qwen2:1.5b
    │                            │                          └→ alert_v2 SSE (帶中文解釋)
    │                            └── 靜態 SPA serving (/static/*)
    └────── plugin → bridge:8765/cmd ────── 反控指令 ─────────────────────────────┘
```

### 關鍵原則

- **Live loop 零 LLM**:規則引擎在 plugin TS,1Hz 全程毫秒級,不碰 Ollama
- **Agent 只在事件**:`judge-1` per-event spawn(2 秒回應),不做常駐
- **單模型 ≤ 2GB**:qwen2:1.5b,絕不上 llama3.2 / gemma
- **單頁 RWD**:Tailwind responsive,Android 同網址直開,不另寫 mobile 版
- **單一 SQLite**:歷史資料寫檔但 dashboard 只顯示 in-memory 60 點 sparkline

---

## Folder layout

```
demo2/
├── .git/                                       # 自己的 repo
├── README.md
├── .gitignore
├── arduino/sensor_station/sensor_station.ino   # Arduino sketch
├── bridge/                                     # Python serial ↔ HTTP
│   ├── bridge.py                               # 主程式 ~150 LOC
│   ├── mock_serial.py                          # 假 Arduino,dev mode
│   ├── config.yaml                             # serial port, plugin URL
│   └── requirements.txt                        # pyserial, fastapi, requests
├── openclaw-plugins/sensor-bridge/
│   ├── package.json, tsconfig.json
│   ├── src/index.ts                            # Fastify 路由 + plugin entry
│   ├── src/sse.ts                              # 改自 demo1 telemetry-source/sse.ts
│   ├── src/static.ts                           # 改自 demo1 local-web-channel
│   ├── src/rules.ts                            # 規則引擎(ring buffer + windowed)
│   ├── src/judge.ts                            # 一次性 agent 呼叫 wrapper
│   ├── src/actuator.ts                         # POST 回 bridge:8765/cmd
│   └── rules.yaml                              # 規則設定
├── openclaw-workspaces/judge-1/
│   ├── SOUL.md, AGENTS.md, IDENTITY.md, TOOLS.md
│   └── (model 在 profile config 裡綁 qwen2:1.5b)
├── dashboard/
│   ├── vite.config.ts                          # base "/static/", host 0.0.0.0
│   ├── index.html
│   └── src/
│       ├── main.tsx, App.tsx
│       ├── components/{SensorCard,AlertBanner,JudgePanel,ActuatorControls}.tsx
│       └── lib/sse.ts
├── scripts/
│   ├── install-plugins.ps1                     # 從 demo1 移植
│   ├── bootstrap-profile.ps1                   # 改 profile 名稱 strixdemo2
│   ├── run-bridge.ps1
│   └── run-mock.ps1
└── docs/{ARCHITECTURE.md, WIRING.md}           # WIRING 含腳位接線圖
```

---

## Wire schemas

### Sensor frame (1Hz, bridge → plugin POST `/api/sensor/ingest`)

```json
{
  "ts": "2026-05-08T10:23:45.123Z",
  "seq": 1837,
  "temp_c": 24.6, "humidity": 58.2,
  "pir": 0,
  "lux_raw": 412,
  "distance_cm": 87.3
}
```

### Alert event (plugin → SSE `/api/alert/stream`,**會發兩次**)

```json
{
  "id": "alert_1715163825_heat",
  "ts": "2026-05-08T10:23:45.123Z",
  "rule": "heat_sustained",
  "severity": "warn",
  "trigger": { "temp_c": 31.4, "duration_s": 65 },
  "explanation": null,           // v1 為 null
  "suggested_action": null,      // v1 為 null
  "actuator_fired": "buzzer"     // 規則同步觸發的反控
}
```

Judge agent 回應後 plugin 再發 v2,把 explanation/suggested_action 填上(同一個 id)。

### Actuator command (plugin → bridge POST `/cmd`)

```json
{ "device": "buzzer", "state": "on", "duration_ms": 2000 }
```

### Rule config (`openclaw-plugins/sensor-bridge/rules.yaml`)

```yaml
rules:
  - id: heat_sustained
    when: { metric: temp_c, op: ">", value: 30, window_s: 60 }
    severity: warn
    actuator: { device: buzzer, state: on, duration_ms: 1500 }

  - id: night_intrusion
    when:
      all:
        - { metric: pir, op: "==", value: 1 }
        - { metric: lux_raw, op: "<", value: 50 }
    severity: critical
    actuator: { device: led, state: red }

  - id: object_too_close
    when: { metric: distance_cm, op: "<", value: 15, window_s: 3 }
    severity: info
```

Plugin 啟動載入,選做 file-watch 熱 reload。

---

## Reuse from demo1(已用 Explore agent 確認檔案路徑)

| 從哪 | 拿什麼 | 怎麼用 |
|---|---|---|
| `demo1/openclaw-plugins/local-web-channel/src/index.ts` (L204–332) | HTTP routes + SSE + static-file pattern + token auth (`extractToken` L106–118) | 抽掉 agent-routing,改成單一 `/api/sensor/ingest` + 兩條 SSE + `/static/*` |
| `demo1/openclaw-plugins/telemetry-source/src/sse.ts` (L16–87) | SSE broadcast registry(heartbeat 15s、write-error resilience、close cleanup)| 直接複製當 `sensor-bridge/src/sse.ts`,留兩個 channel(sensor/alert) |
| `demo1/scripts/install-plugins.ps1` (L1–84) | 自動偵測 plugins、build、複製到 `~/.openclaw-strixdemo2/extensions/`、複製 dashboard/dist 進 plugin/static | 改 profile 名稱即可,結構不動 |
| `demo1/scripts/bootstrap-profile.ps1` | 寫 `~/.openclaw-strixdemo2/openclaw.json`(`gateway.bind: "lan"`) | profile 名稱 + agents.list[]:只放 judge-1,模型綁 qwen2:1.5b |
| `demo1/openclaw-workspaces/doc-1/{SOUL,AGENTS,IDENTITY,TOOLS}.md` | minimal agent workspace 樣板 | 改寫成 judge-1:任務只有「給異常 JSON,回 1 句中文解釋 + 建議動作」,輸出強制 JSON |
| `demo1/dashboard/vite.config.ts` | `base: "/static/"` + React 19 + Tailwind 設定 | 整個 vite.config + tsconfig + tailwind.config 複製,只改 components 內容 |

可重用佔比約 60%(SSE + 靜態 + installer + workspace 樣板 + Vite 設定)。新東西主要是 Arduino sketch、Python bridge、rules engine、Judge agent prompt。

---

## Components

### Arduino sketch(~80 LOC,non-blocking)

- `setup()`:Serial 9600、DHT22 init、HC-SR04 trig pin、buzzer/LED pin OUTPUT
- `loop()`:`millis()` 計時 1000ms 取樣一次,讀 4 sensor,印 CSV `seq,temp,hum,pir,lux,dist\n`
- `serialEvent()` 解析 `BUZZER ON 2000` / `LED RED` / `LED OFF` 指令,設定 pin + 計時關閉

### Python bridge(`bridge.py`,~150 LOC,單檔)

- pyserial reader thread:每行 CSV → parse → `requests.post(plugin_url + "/api/sensor/ingest", json=...)` → 同時 INSERT 進 SQLite `sensor_log` table
- FastAPI server `:8765/cmd`:接 plugin 反控 JSON,寫一行給 serial
- `--mock` flag:swap 進 `mock_serial.py`(假資料生成器:溫度正弦漂移、PIR 隨機 ~30s 一次、光感跟系統時間日夜、距離 random walk;`--force-heat` flag 把 temp 設成 32 持續 70s 用來觸發規則)

### sensor-bridge plugin

- Fastify routes:
  - `POST /api/sensor/ingest`:接 frame → SSE broadcast → `rules.evaluate(frame, ringBuffer)`
  - `GET /api/sensor/stream`:SSE
  - `GET /api/alert/stream`:SSE
  - `GET /static/*`:dashboard SPA
  - `POST /api/actuator`:dashboard 手動覆寫(轉發到 bridge `/cmd`)
- `rules.ts`:120 frame ring buffer + windowed condition + dedup(同 rule 觸發中不重發)
- `judge.ts`:fire-and-forget async,呼叫 `runtime.subagent.run({ sessionKey: "agent:judge-1:..." })`,回應 timeout 5s,失敗就跳過 v2(v1 alert 已經發了,UI 還是有東西看)
- `actuator.ts`:小 wrapper POST 到 `bridge_url + "/cmd"`

### judge-1 agent

- 模型:Ollama qwen2:1.5b(W2 才裝,W1 規則就夠)
- SOUL.md:「你是設備監控助理。輸入是異常 JSON。**只能回應**單一 JSON `{"explanation": "繁體中文一句", "suggested_action": "繁體中文一句"}`。不要其他文字。」
- TOOLS.md:`message`(implicit reply only)
- 沒有 chat tool、沒有 web、沒有 sessions_spawn

### Dashboard(5 個 component 上限)

- `App.tsx`:SSE 訂閱 + 全域 state
- `SensorCard.tsx`:4 個 instance,各自顯示數值 + threshold 染色 + 60 點 in-memory sparkline(SVG,不用 chart lib)
- `AlertBanner.tsx`:置頂、可關閉、嚴重度顏色
- `JudgePanel.tsx`:列最近 5 條 explanation
- `ActuatorControls.tsx`:手動 buzzer/LED 按鈕(練習雙向 + demo 互動)
- Tailwind RWD:`md:grid-cols-4` → 桌機 4 欄,手機自動疊單欄

---

## Milestones

### W1(週 1–1.5):**規則骨幹** demoable

- Arduino 接好線、燒錄、可從 serial monitor 看到 CSV
- Python bridge 在 mock 模式跑得起來,SQLite 有 row 進
- Plugin 收 ingest、broadcast 兩條 SSE、serve 靜態
- Dashboard 4 張卡片即時更新
- 2 條 hardcoded 規則會 fire alert(W1 不必載 YAML,直接寫死)
- LAN bind 開好,手機連同網址看得到
- **零 agent、零 Ollama、零反控**(只看)

### W2(週 2–3):**智慧 + 反控**

- YAML rule loader、第 3 條規則
- Ollama 裝起 qwen2:1.5b、judge-1 workspace 寫好
- Async enrichment:alert_v2 帶中文解釋
- 反控路徑通了:規則 fire → 蜂鳴器/LED 真的響/亮
- Dashboard 加 ActuatorControls 手動覆寫
- Android 實機驗證 RWD

---

## Critical files to create

| 路徑 | 用途 |
|---|---|
| `demo2/arduino/sensor_station/sensor_station.ino` | Arduino sketch |
| `demo2/bridge/bridge.py` | Python 主橋 |
| `demo2/bridge/mock_serial.py` | 假資料 |
| `demo2/openclaw-plugins/sensor-bridge/src/index.ts` | Plugin entry |
| `demo2/openclaw-plugins/sensor-bridge/src/rules.ts` | 規則引擎 |
| `demo2/openclaw-plugins/sensor-bridge/src/judge.ts` | Agent 呼叫 wrapper |
| `demo2/openclaw-plugins/sensor-bridge/rules.yaml` | 規則設定 |
| `demo2/openclaw-workspaces/judge-1/SOUL.md` | Judge agent persona |
| `demo2/dashboard/src/App.tsx` | SPA 主元件 |
| `demo2/scripts/install-plugins.ps1` | 安裝腳本 |
| `demo2/scripts/bootstrap-profile.ps1` | profile init |

---

## Verification(沒有 Arduino 也能 smoke test)

1. **Mock 模式 happy path**(整週 1 都用這個驗)
   - `scripts/run-mock.ps1` 一鍵起 plugin + bridge --mock + dashboard dev server
   - 開瀏覽器 `http://127.0.0.1:18789/?token=...`
   - 看 4 卡片數值在動、sparkline 正在畫
   - 等 30s 看 PIR 隨機觸發、看 night_intrusion 規則 fire alert banner

2. **Mock 強制觸發 heat 規則**
   - `python bridge.py --mock --force-heat` 30 秒內看到 banner
   - mock 的 `/cmd` 收到 buzzer 命令會 print 在 terminal(不寫真 serial)

3. **W2 加上 Judge 後**
   - alert v1 出現後 ~2s,banner 多出中文 explanation 字
   - 看 plugin log:`judge.run took 2147ms`

4. **手機驗證**
   - 同 LAN 開 Chrome 連 `http://<PC ip>:18789/?token=...`
   - 4 欄變成 1 欄、字夠大、SSE 持續推

5. **Vitest 單元測試**(`tests/rules.test.ts`)
   - heat_sustained:溫度衝高 60s 觸發 1 次,降回 < 30 後重置,再衝高再觸發 1 次(沒有 dedup leak)
   - night_intrusion:同時滿足兩條件才 fire
   - object_too_close:windowed 3s 內持續 < 15 才 fire

6. **真 Arduino 接線後**(W2 末)
   - 切 `--mock` 關掉、指 real `COM3` 之類
   - 對著 PIR 揮手 → 卡片變色 → 蜂鳴器響
   - 手蓋住光感 → night 規則 fire → LED 變紅

---

## NOT 包含的東西(避免再次膨脹)

| 不做 | 理由 |
|---|---|
| Dashboard 對話框 | 不是 chat 系統。Agent 是事件觸發,不是對話 |
| 多 agent | 一個 Judge,沒了 |
| llama3.2 / 7B+ 模型 | 直接違背 RAM 目標 |
| MQTT / Kafka / Redis | 1Hz HTTP+SQLite 完全夠 |
| 多小時歷史圖表 | 60 點 in-memory sparkline 即可,SQLite 留資料只為了未來 export |
| Postgres / TimescaleDB | 一個 SQLite 檔解決 |
| 帳號登入 | LAN demo,token query 加 firewall scope |
| Drools / 外部規則服務 | YAML + ts evaluator |
| Docker | 直接 pnpm/python,跟 demo1 一致 |
| 鏡頭 / 視覺辨識 | 4 sensor 是 scope。要視覺另一個 demo |
| Native mobile app | RWD SPA on Chrome 夠了 |
| 常駐 agent process | per-event spawn 才省 RAM |

---

## Open items(計畫之外、之後再決定)

- qwen2:1.5b vs phi-3-mini-instruct 哪個中文更穩(W2 開頭比較一輪選一個)
- rules.yaml 熱 reload 要不要做(可以延後,改檔重啟 plugin 也能接受)
- Android 是否需要鎖橫幅 / 螢幕常亮(用 wake lock API)— 看 W2 實測效果再決定
- 是否做一個 Computex 50 秒 demo runner(類似 demo1 T10.1)— 等架構穩了再想
