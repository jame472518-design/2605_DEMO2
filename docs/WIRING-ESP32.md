# WIRING-ESP32.md — demo2 接線(ESP32-S3-CAM 版)

板子:**GOOUUU ESP32-S3-CAM N16R8**(OV2640 camera + 16MB flash + 8MB PSRAM)

> 這份取代 `WIRING.md`(那是 Arduino Uno 版,留著當參考)。
>
> demo2 韌體分兩階段。**Phase 1** 沿用 `20260308_esp32_wifi_tracker` project
> 已經接好的硬體;**Phase 2** 在 Phase 1 之上加上原本 W3 plan 規劃但 Phase 1
> 沒有的感測器與致動器。可以只跑 Phase 1 就上 demo,Phase 2 是錦上添花。

---

## Phase 1 vs Phase 2 一表速覽

| 元件 | Phase | GPIO | 角色 | 來源 |
|---|---|---|---|---|
| **DHT11** 溫濕度 | 1 | 2 | 1Hz 上傳 temp_c / humidity | prev project |
| **SG90 Servo (Pan)** 鏡頭水平 | 1 | 14 | `/cmd device=servo state=pan angle=N` | prev project |
| **SG90 Servo (Tilt)** 鏡頭垂直 | 1 | 3 | `/cmd device=servo state=tilt angle=N` | prev project |
| **OLED SH1106 1.3"** | 1 | 47 / 48 (I2C) | on-device 顯示 T / H / Mic / IP / seq | prev project |
| **INMP441 mic** | 1 | 38 / 39 / 40 (I2S) | RMS 上傳 audio_rms | prev project |
| **OV2640 camera** | 1 | 板子固定 | MJPEG :81/stream + /capture | prev project |
| **PIR HC-SR501** | 2 | 21 | 動作偵測 → `night_intrusion` 規則 | demo2 plan |
| **LDR** 光感 | 2 | 1 (ADC1_CH0) | 環境亮度 → `night_intrusion` 規則 | demo2 plan |
| **HC-SR04 trig** | 2 | 42 | 超音波距離(觸發) | demo2 plan |
| **HC-SR04 echo** | 2 | 41 | 超音波距離(回波) **必加 5V→3.3V 分壓** | demo2 plan |
| **主動 Buzzer** | 2 | 43 | 警報音 → `heat_sustained` 規則 actuator | demo2 plan |
| **LED 紅 5mm** | 2 | 44 | 警報燈 → `night_intrusion` 規則 actuator | demo2 plan |

避開的腳位(板子已用):4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17, 18(Camera);19, 20(若 USB CDC enabled);47, 48(我們的 OLED I2C)。

---

## Phase 1 — 詳細接法

### 系統概觀(Phase 1)

```
ESP32-S3-CAM (5V USB or 5V external)
   │
   ├─ DHT11 (data → GPIO 2,  3.3V VCC, GND)              ← + 4.7kΩ pull-up 到 3.3V
   ├─ SG90 Pan (sig → GPIO 14, 5V VCC, GND)              ← 鏡頭水平
   ├─ SG90 Tilt (sig → GPIO 3,  5V VCC, GND)             ← 鏡頭垂直
   ├─ OLED SH1106 (SDA → GPIO 47, SCL → GPIO 48, 3.3V)   ← on-device 顯示
   ├─ INMP441 mic (SCK 38, WS 39, SD 40, L/R→GND, 3.3V)  ← 音量量測
   └─ OV2640 camera(板上)                               ← 自動使用
```

WiFi 連 demo2 PC(2.4GHz)。USB 只用來上傳韌體,正式運轉只需 5V 電源(可用 USB 也可外接)。

### Phase 1 腳位表

| ESP32 GPIO | 元件 | 接法 | 備註 |
|---|---|---|---|
| **5V** | 主匯流排 +5V | 麵包板 + 軌 | 給 servo VCC |
| **3.3V** | 副匯流排 +3.3V | 麵包板 + 軌 | DHT11 / OLED / INMP441 / DHT11 pull-up |
| **GND** | 共地 | 麵包板 - 軌 | 所有元件共地 + INMP441 L/R(選通道) |
| `GPIO 2`  | DHT11 data    | DHT11 中央 pin → GPIO 2 → 4.7kΩ → 3.3V | pull-up 必裝,沒裝會讀 NaN |
| `GPIO 3`  | Tilt servo    | SG90 signal(橘)→ GPIO 3,VCC 紅 → 5V,GND 棕 → GND | 50Hz PWM,鏡頭俯仰 |
| `GPIO 14` | Pan servo     | SG90 signal(橘)→ GPIO 14,VCC 紅 → 5V,GND 棕 → GND | 50Hz PWM,鏡頭左右 |
| `GPIO 38` | INMP441 SCK   | mic SCK → GPIO 38                       | I2S clock |
| `GPIO 39` | INMP441 WS    | mic WS → GPIO 39                        | I2S word-select |
| `GPIO 40` | INMP441 SD    | mic SD → GPIO 40                        | I2S data |
| `GPIO 47` | OLED SDA      | OLED SDA → GPIO 47                      | I2C,400kHz |
| `GPIO 48` | OLED SCL      | OLED SCL → GPIO 48                      | I2C,400kHz |

INMP441 的 **L/R 接 GND**(選 LEFT 通道,跟韌體 `I2S_CHANNEL_FMT_ONLY_LEFT` 對應)、**VDD 接 3.3V**,別接 5V。

### 關鍵接線細節(Phase 1)

**1. DHT11 pull-up(必加)**

```
3.3V ──┬── DHT11 data pin
       │
      4.7kΩ
       │
GPIO 2 ── DHT11 data pin (同一條線)
```

沒裝會一直讀 NaN。

**2. SG90 servo 電源**

SG90 標稱 5V,**不要接 3.3V**。瞬間扭矩大時 USB 5V 可能掉到 4V 以下導致 ESP32 重啟,真要穩可外接 5V 1A。signal 直接接 ESP32 GPIO(3.3V 邏輯,SG90 接受)。

**3. OLED 選對控制器**

買的是 **SH1106 1.3"**(不是 SSD1306 0.96")。兩個 I2C 位址都是 0x3C 但 controller 不同,韌體用 `U8G2_SH1106_128X64_NONAME_F_HW_I2C`。如果你拿到 SSD1306,把那行換成 `U8G2_SSD1306_128X64_NONAME_F_HW_I2C` 就好。

**4. INMP441 的 L/R**

L/R 接 GND = 左通道。如果你把它接 3.3V 會變右通道,而韌體只讀左通道 → 永遠收 0。

---

## Phase 2 — 之後再加的硬體

### Phase 2 增量接法

只列「Phase 1 沒有但要新加」的元件。

| ESP32 GPIO | 元件 | 接法 | 備註 |
|---|---|---|---|
| `GPIO 1`  | LDR (analog)  | 3.3V → LDR → GPIO 1 → 10kΩ → GND | ADC1_CH0;WiFi 開時只 ADC1 可靠 |
| `GPIO 21` | PIR out       | HC-SR501 OUT → GPIO 21          | HC-SR501 OUT 是 3.3V level,直接接 OK |
| `GPIO 42` | HC-SR04 trig  | HC-SR04 Trig → GPIO 42          | 3.3V 對 HC-SR04 trig 偵測足夠 |
| `GPIO 41` | HC-SR04 echo  | HC-SR04 Echo → 1kΩ → GPIO 41 + 2kΩ → GND | **必加分壓!** echo 是 5V |
| `GPIO 43` | Buzzer +      | GPIO 43 → 主動 buzzer 紅,黑 → GND | 主動式直接 digitalWrite HIGH 響 |
| `GPIO 44` | LED 紅 +      | GPIO 44 → 220Ω → LED 長腳,短腳 → GND | 220Ω 限流 |

### Phase 2 關鍵接線細節

**1. HC-SR04 echo 5V → 3.3V 分壓(必加)**

```
HC-SR04 Echo ── 1kΩ ──┬── GPIO 41
                       │
                      2kΩ
                       │
                      GND
```

電阻比 1:2 → 5V × 2/(1+2) = 3.33V。**不裝會燒 ESP32 GPIO 41**。

**2. LDR 分壓**

光感是電阻不是 sensor 模組,要組分壓:

```
3.3V ── LDR ──┬── GPIO 1 (analog)
              │
            10kΩ
              │
             GND
```

亮 → LDR 阻低 → GPIO 1 接近 3.3V → analogRead ≈ 4095。
暗 → LDR 阻高 → GPIO 1 接近 0V → analogRead ≈ 0。

`night_intrusion` 規則閾值 lux_raw < 50(rules.yaml 可微調)。

**3. 主動式 vs 被動式 buzzer**

買 **主動式**(寫著 active / 加電就響的)。被動式要 PWM 才有聲,韌體沒寫 PWM。

**4. LED 限流**

220Ω 串聯。直接接會在數秒內燒掉 LED。

---

## BOM(零件清單)

### Phase 1(prev project 你已經有)

| ✓ | 數 | 元件 | 備註 |
|:---:|:---:|---|---|
| ✓ | 1 | ESP32-S3-CAM N16R8 (GOOUUU 牌) | 已有 |
| ✓ | 1 | DHT11 模組 | 已有 |
| ✓ | 2 | SG90 SERVO | 已有(pan+tilt 各一) |
| ✓ | 1 | OLED SH1106 1.3" | 已有 |
| ✓ | 1 | INMP441 麥克風 | 已有 |
| ✓ | 1 | 4.7kΩ 電阻 | DHT11 pull-up |
| ✓ | 1 | 麵包板 + 跳線 | 已有 |
| ✓ | 1 | USB-C 線(資料) | 燒錄 + 5V 供電 |

### Phase 2(需要採購)

| ? | 數 | 元件 | 備註 |
|:---:|:---:|---|---|
| ? | 1 | HC-SR501 PIR 模組 | |
| ? | 1 | LDR(光敏電阻,任意阻值)| |
| ? | 1 | HC-SR04 超音波模組 | |
| ? | 1 | 主動式蜂鳴器 | 不要買被動式 |
| ? | 1 | LED 紅 5mm | |
| ? | 1 | 220Ω 電阻 | LED 限流 |
| ? | 1 | 1kΩ 電阻 | HC-SR04 echo 分壓 |
| ? | 1 | 2kΩ 電阻(或 2 顆 1kΩ 串)| HC-SR04 echo 分壓 |
| ? | 1 | 10kΩ 電阻 | LDR 分壓 |

露天 / 蝦皮搜尋「ESP32 sensor 套件」常常一包含上面大半。

---

## 燒錄與 boot

### 第一次設定

1. Arduino IDE 1.8+ 或 2.x
2. **Tools → Board → ESP32 Arduino → ESP32S3 Dev Module**
3. **Tools → USB CDC On Boot → Disabled**
4. **Tools → Flash Size → 16MB**
5. **Tools → PSRAM → OPI PSRAM**
6. **Tools → Partition Scheme → Huge APP (3MB No OTA/1MB SPIFFS)**
7. **Tools → Manage Libraries** 安裝:
   - `DHT sensor library` by Adafruit
   - `Adafruit Unified Sensor`(自動)
   - `U8g2` by Oliver Kraus
8. 複製 `arduino/esp32_sensor_node/secrets.h.example` 到同目錄 `secrets.h` 並填:
   - `WIFI_SSID` / `WIFI_PASSWORD` — 你的 2.4GHz WiFi
   - `PC_HOST` — demo2 PC 的 LAN IP(`ipconfig` 看)
   - `GATEWAY_TOKEN` — 從 `demo2/.env.local` 複製
9. **先燒 component_test**(`arduino/component_test/component_test.ino`)做硬體 sanity:
   - Serial Monitor 115200 baud
   - 依序輸入 `1` (DHT) `2` (pan) `3` (tilt) `8` (OLED) `9` (live) `m` (mic) `4` (camera) `5` (WiFi)
   - 全綠才換正式韌體
10. 燒 `esp32_sensor_node.ino`

### Serial Monitor 會看到

```
=== demo2 ESP32-S3-CAM sensor node (Phase 1) ===
DHT11 driver attached (GPIO 2)
Servos centered (Pan=14, Tilt=3)
INMP441 mic ready (GPIO 38/39/40)
Camera initialized (OV2640 VGA)
Connecting to WiFi 'YourSSID'...........
Connected. IP=192.168.1.42 RSSI=-52
NTP sync requested
HTTP server :80 ready (/, /cmd, /capture)
HTTP server :81 ready (/stream)
Stream:  http://192.168.1.42:81/stream
Capture: http://192.168.1.42/capture
Setup complete.
```

之後 1Hz 一筆 sensor frame 進 demo2 plugin。失敗會 log `ingest POST failed code=...`。

---

## 排錯

| 症狀 | 原因 | 處理 |
|---|---|---|
| `Camera init failed` | PSRAM 設錯 / Flash size 錯 | PSRAM = OPI PSRAM、Flash = 16MB |
| WiFi 連不上 | 5GHz only / SSID 拼錯 / 密碼錯 | ESP32-S3 只吃 2.4GHz |
| `ingest POST failed code=-1` | PC_HOST 不通 | 同 LAN?firewall 開 :18790? |
| `ingest POST failed code=401` | token 錯 | 從 `.env.local` 重抓最新 token,改 `secrets.h` 重燒 |
| Temp 一直 NaN(-127 上傳) | DHT11 pull-up 沒裝 / 線錯 | 4.7kΩ 確認在 3.3V 跟 data 之間 |
| Servo 抖動 / 重開機 | 5V 電不夠 | USB hub 換 1A 以上、或外接 5V |
| OLED 沒畫面 | 控制器選錯 / SDA/SCL 接反 | 確認是 SH1106,SDA=47 SCL=48 |
| Mic 永遠收 0 | INMP441 L/R 接 3.3V 而非 GND | L/R → GND(選左通道) |
| Dashboard camera 卡住載入 | 瀏覽器 fetch ESP_IP:81 失敗 | 另開 tab 連 `http://ESP_IP:81/stream` 試 |
| Phase 2 規則一直不 fire | 韌體沒上傳 pir/lux/distance | 預期行為,Phase 2 拉線才有 |
