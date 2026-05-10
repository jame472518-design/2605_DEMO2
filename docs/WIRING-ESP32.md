# WIRING-ESP32.md — demo2 接線(ESP32-S3-CAM 版)

板子:**GOOUUU ESP32-S3-CAM N16R8**(OV2640 camera + 16MB flash + 8MB PSRAM)

> 這份取代 `WIRING.md`(那是 Arduino Uno 版,留著當參考)。

---

## 系統概觀

```
ESP32-S3-CAM (5V USB or 5V external)
   │
   ├─ DHT11 (data → GPIO 21)
   ├─ PIR HC-SR501 (out → GPIO 41)
   ├─ LDR (analog → GPIO 1)
   ├─ HC-SR04 (trig → GPIO 42, echo → GPIO 45 via 5V→3.3V 分壓)
   ├─ Buzzer (active, → GPIO 46)
   ├─ LED red 5mm (→ GPIO 19, 220Ω 串聯)
   └─ OV2640 camera(已焊在板子上,不用接)
```

WiFi 連 demo2 PC,沒有 USB serial 連線需求(設定 + 除錯時插 USB,正式運轉只需要 5V 電源)。

---

## 腳位表

| ESP32 GPIO | 元件 | 接法 | 備註 |
|---|---|---|---|
| **5V** | 主匯流排 +5V | 麵包板 + 軌 | DHT11、PIR、HC-SR04、buzzer 都吃 5V |
| **3.3V** | 副匯流排 +3.3V | 麵包板 + 軌 | LDR 分壓上拉用,DHT11 pull-up 也拉這裡 |
| **GND** | 共地 | 麵包板 - 軌 | 所有元件共地 |
| `GPIO 1`  | LDR (analog)  | 5V/3.3V → LDR → GPIO 1 → 10kΩ → GND | ADC1_CH0;WiFi 開時只 ADC1 可靠 |
| `GPIO 21` | DHT11 data    | DHT11 中央 pin → GPIO 21 → 4.7kΩ → 3.3V | pull-up 必裝,沒裝會讀 NaN |
| `GPIO 41` | PIR out       | HC-SR501 OUT → GPIO 41 | HC-SR501 模組 OUT 是 3.3V level,直接接 OK |
| `GPIO 42` | HC-SR04 trig  | HC-SR04 Trig → GPIO 42 | 3.3V 對 HC-SR04 trig 偵測足夠 |
| `GPIO 45` | HC-SR04 echo  | HC-SR04 Echo → 1kΩ → GPIO 45 + 2kΩ → GND | **必加分壓!** echo 是 5V,直接接會燒 ESP32 |
| `GPIO 46` | Buzzer +      | GPIO 46 → 主動式 buzzer 紅線,黑線 → GND | 主動式 buzzer 直接 digitalWrite HIGH 響 |
| `GPIO 19` | LED 紅 +      | GPIO 19 → 220Ω → LED 長腳,LED 短腳 → GND | 220Ω 限流避免燒 LED |

避開的腳位(板子已用):
- 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17, 18 — Camera (OV2640)
- 47, 48 — OLED I2C(板上若沒焊 OLED 也不要碰,廠商可能保留)
- 38, 39, 40 — INMP441 麥克風(沒裝就無所謂)

---

## 麵包板布線示意

```
ESP32-S3-CAM 邊                            麵包板邊
┌──────────┐
│   5V  o ─┼──────────────► +5V 匯流排 ─┬─► DHT11 VCC
│  3V3  o ─┼──────────────► +3V3 匯流排 │   PIR VCC
│  GND  o ─┼──────────────► GND  匯流排 │   HC-SR04 VCC
│ GP 1  o ─┼─── ADC ──┐                 │   buzzer 紅
│ GP19  o ─┼─── LED ──┼─ 220Ω ─ LED ─┐  │
│ GP21  o ─┼─── DHT ──┼──────────────┤  │   LDR 上端 ──┐
│ GP41  o ─┼─── PIR ──┼──────────────┤  │              │ 5V/3.3V
│ GP42  o ─┼─── trig ─┼──────────────┤  │   GP1 中端 ─┤  └─ LDR
│ GP45  o ─┼─── echo ──┐ 1k         │  │              │     │
│ GP46  o ─┼─── BUZ ──┐│             │  │   GND 下端  ─┴─ 10kΩ ─┘
└──────────┘          ││             │  │
                      ││ 2k          ↓  ↓  全部 → GND
                      └┴─────────────────► GND
                            │
                       HC-SR04 echo 5V
```

(ASCII 略示意,完整連線看上面腳位表)

---

## 關鍵接線細節

### 1. DHT11 pull-up(必加)

```
3.3V ──┬── DHT11 data pin
       │
      4.7kΩ
       │
GPIO 21 ── DHT11 data pin (同一條線)
```

DHT11 三腳:VCC(5V)、data(中央)、GND。**data 線一定要 pull-up 到 3.3V** 透過 4.7kΩ 電阻,沒裝會一直讀 NaN。

### 2. HC-SR04 echo 5V → 3.3V 分壓(必加)

HC-SR04 echo pin 是 5V 邏輯,ESP32 GPIO 上限 3.3V。**直接接會燒 ESP32**。分壓:

```
HC-SR04 Echo ── 1kΩ ──┬── GPIO 45
                       │
                      2kΩ
                       │
                      GND
```

電阻比 1:2 → 5V * 2/(1+2) = 3.33V,正好。

### 3. LDR 分壓

光感是電阻,不是 sensor 模組。要組成分壓:

```
3.3V ── LDR ──┬── GPIO 1 (analog)
              │
            10kΩ
              │
             GND
```

亮 → LDR 電阻低 → GPIO 1 電壓接近 3.3V → analogRead ≈ 4095。
暗 → LDR 電阻高 → GPIO 1 電壓接近 0V → analogRead ≈ 0。

`night_intrusion` 規則閾值是 lux_raw < 50,**全黑**時觸發。校正用手蓋住 LDR 看 dashboard 數值掉到多少,微調 rules.yaml。

### 4. 主動式 vs 被動式 buzzer

買**主動式 buzzer**(寫著 active 或表示加電就響的)。被動式 buzzer 要 PWM 才有聲。GPIO 46 直接 digitalWrite HIGH 響、LOW 停。

### 5. LED 限流

LED 順向壓降 ~2V,3.3V GPIO 拉 LED:(3.3 - 2) / 0.005 = 260Ω。買 **220Ω**(常見值,稍微亮一點)就好。直接接會燒 LED。

---

## BOM(零件清單)

| 已有(✓)?  | 數 | 元件 | 備註 |
|:---:|:---:|---|---|
| ✓ | 1 | ESP32-S3-CAM N16R8 (GOOUUU 牌或同等) | 已有 |
| ? | 1 | DHT11 模組(三腳 dipped,自帶板)| 你說現有,或 raw 三腳 |
| ? | 1 | HC-SR501 PIR 模組 | |
| ? | 1 | LDR(光敏電阻,任意阻值)| |
| ? | 1 | HC-SR04 超音波模組 | |
| ? | 1 | 主動式蜂鳴器 | 不要買被動式 |
| ? | 1 | LED 紅 5mm | |
| ? | 1 | 麵包板 (400+ 點) | |
| ? | 20+ | 跳線(公-公、公-母混合)| ESP32 是公頭,所以多備母-公 |
| ? | 1 | 220Ω 電阻(¼W) | LED 限流 |
| ? | 1 | 4.7kΩ 電阻 | DHT11 pull-up |
| ? | 1 | 1kΩ 電阻 | HC-SR04 echo 分壓 |
| ? | 1 | 2kΩ 電阻(或 2 顆 1kΩ 串)| HC-SR04 echo 分壓 |
| ? | 1 | 10kΩ 電阻 | LDR 分壓 |
| ? | 1 | USB-C 線(資料) | 燒錄 + 5V 供電 |

露天 / 蝦皮搜尋關鍵字:「ESP32 開發套件 sensor 包」常常一包含上面大半零件。

---

## 燒錄與 boot

### 第一次設定

1. Arduino IDE 1.8+ 或 2.x
2. **Tools → Board → ESP32 Arduino → ESP32S3 Dev Module**
3. **Tools → USB CDC On Boot → Disabled**(讓 GPIO 19/20 給 LED 用)
4. **Tools → Flash Size → 16MB**
5. **Tools → PSRAM → OPI PSRAM**
6. **Tools → Partition Scheme → Huge APP (3MB No OTA/1MB SPIFFS)**
7. **Tools → Manage Libraries** 安裝:
   - `DHT sensor library` by Adafruit
   - `Adafruit Unified Sensor`(DHT 依賴,通常自動裝)
8. 複製 `secrets.h.example` 到 `secrets.h` 並填值:
   - `WIFI_SSID` / `WIFI_PASSWORD` — 你的 2.4GHz WiFi(ESP32-S3 不支援 5GHz)
   - `PC_HOST` — demo2 PC 的 LAN IP(ipconfig 看)
   - `GATEWAY_TOKEN` — 從 `demo2/.env.local` 複製
9. 開 `esp32_sensor_node.ino`,選 COM port,按 Upload

### Serial Monitor 會看到

```
=== demo2 ESP32-S3-CAM sensor node ===
Camera initialized
Connecting to WiFi 'YourSSID'...........
Connected. IP=192.168.1.42 RSSI=-52
NTP sync requested
HTTP server :80 ready (/, /cmd, /capture)
HTTP server :81 ready (/stream)
Stream:  http://192.168.1.42:81/stream
Capture: http://192.168.1.42/capture
Setup complete.
```

之後每秒一筆 sensor frame 進 demo2 plugin。失敗會 log `ingest POST failed code=...`。

---

## 排錯

| 症狀 | 原因 | 處理 |
|---|---|---|
| `Camera init failed` | PSRAM 設定錯,或板子問題 | 確認 PSRAM = OPI PSRAM、Flash = 16MB |
| WiFi 連不上 | 5GHz only / SSID 拼錯 / 密碼錯 | ESP32-S3 只吃 2.4GHz,改用 2.4GHz SSID |
| `ingest POST failed code=-1` | PC_HOST 不通 | ESP32 與 PC 同一 LAN?firewall 開 :18790? |
| `ingest POST failed code=401` | token 錯 | 從 `.env.local` 重抓最新 token,改 `secrets.h` 重燒 |
| 溫度一直 -127 | DHT pull-up 沒裝或接錯 | 檢查 4.7kΩ 在 3.3V 跟 data 之間 |
| 距離一直 999 | HC-SR04 沒分壓 / 接錯 / 板子壞 | 先確認分壓,然後測 5V 電源夠不夠(USB 電流不足會 flaky) |
| Dashboard camera 卡住載入 | 瀏覽器 fetch ESP_IP:81 失敗 | 開新 tab 直接連 `http://ESP_IP:81/stream` 試 |
