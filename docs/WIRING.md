# WIRING.md — demo2 sensor station 接線

預設 Arduino 板子是 Uno / Nano(5V),腳位定義在 `arduino/sensor_station/sensor_station.ino` 開頭。

## 腳位表

| 元件 | Arduino 腳位 | 備註 |
|---|---|---|
| DHT22 data | D2 | 4-pin 模組,5V/GND/data;data 接 4.7kΩ pull-up 到 5V |
| PIR motion (HC-SR501) | D3 | 5V/GND/OUT;板上有靈敏度 + 延遲調整旋鈕 |
| Photoresistor (LDR) | A0 | 與 10kΩ 串聯分壓:5V → LDR → A0 → 10kΩ → GND |
| HC-SR04 trig | D8 | 5V/GND/Trig/Echo 四線 |
| HC-SR04 echo | D9 | 注意 Echo 是 5V,Arduino 5V 直接讀;若改用 3.3V 板要分壓 |
| Buzzer (active) | D11 | 主動式蜂鳴器,DigitalWrite HIGH 即發聲 |
| LED 紅 | D5 | 串 220Ω |
| LED 綠 | D6 | 串 220Ω |
| LED 藍 | D7 | 串 220Ω |

如果你只有單色 LED:接到 D5,移除 ino 裡的 G/B 指令,或把所有 `setLed(r,g,b)` 改成只 `digitalWrite(PIN_LED_R, r ? HIGH : LOW)`。

## 麵包板建議

- 5V/GND 主匯流排接 Arduino 的 5V/GND 各一條
- DHT22 的 4.7kΩ pull-up 是穩定讀數的關鍵,別漏
- HC-SR04 跟 PIR 同時 5V 沒問題,但長線可能干擾,接 USB 線盤好
- 蜂鳴器接電晶體(2N2222 + 1kΩ base 串)更安全,若只是 demo 直接 D11 也撐得住

## 燒錄

Arduino IDE 開啟 `arduino/sensor_station/sensor_station.ino`,選 Uno + 對的 COM port,Tools → Manage Libraries 安裝:

- `DHT sensor library` by Adafruit (含 `DHT.h`)
- `Adafruit Unified Sensor`(DHT 依賴)

按 Upload。Serial Monitor 9600 baud 應該每秒出現一行 `seq,temp,humidity,pir,lux,distance`。

## 驗證

```
1,24.20,58.30,0,412,87.3
2,24.21,58.45,0,415,86.9
3,24.20,58.50,1,410,86.5    <- 揮手過 PIR
```

如果某顆 sensor 沒接、值是 -127(temp)、-1(humidity)、999(distance)、PIR 一直 1 或 0:檢查接線。
