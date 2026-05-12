# README-OPERATIONS.md — demo2 展場操作手冊

> Strix Halo AI Sensor Station — booth operator quick reference. 1 頁,從開機到下班,中間遇到問題對應到哪一段。

---

## 開機 — 一鍵啟動

1. **手機熱點先開**(SSID 跟 `arduino/esp32_sensor_node/secrets.h` 一致)
2. **ESP32-S3-CAM 接電**(USB-C 5V,或外接電源)
3. **桌面雙擊「demo2 booth」捷徑**,或 PowerShell 跑:
   ```powershell
   cd C:\Users\jame4\Desktop\PROJECT\202605_demo_project\demo2
   .\scripts\start-booth.ps1
   ```
4. 預期:
   - PowerShell 視窗開 3 個(launcher / gateway / 可能還有 bridge)
   - **Firefox 全螢幕 kiosk 自動開**,直接顯示 dashboard
   - 右下角浮著一個小 QR code,給訪客掃手機看

**所有 sensor card 跳數字 + ESP32 鏡頭出畫面 = 系統正常運作**。

---

## 開幕前 30s 體檢

| 看哪 | 該長什麼樣 |
|---|---|
| **header status pills** | 4 顆全綠(`gateway 18790 / ingest live / judge qwen2:1.5b / seq 00xxx`) |
| **TEMP / HUMID 卡** | 數值跳動,sparkline 有曲線 |
| **MOTION / LUX / DIST** | Phase 2 沒接 → 顯示 `—`(預期,正常) |
| **ESP32 鏡頭** | MJPEG 即時影像,右上 `REC` 紅點閃 |
| **OLED on ESP32** | T / H 即時跳,Mic 條圖會動,seq 一直加 |

任何一項 NG → 跳到下面對應故障排除。

---

## 訪客互動劇本(operator 不用碰,讓訪客自己玩)

1. **看畫面就懂的部分**:5 張 sensor 卡 + 即時鏡頭
2. **PAN / TILT 滑桿**:在右下「manual override」卡片,拖一下 → 鏡頭真的轉
3. **👁 SCAN 按鈕**:在每個鏡頭右上角,按一下 → 20-30 秒後底部跳一句中文「看到什麼」
4. **📱 SCAN QR**:右下角 QR,訪客掃手機 → 看到同一個 dashboard(同 WiFi 才行)
5. **alert 觸發**:把熱風吹溫度感測器 / 把 ESP32 蓋黑 → banner 跳出,judge 寫中文解釋

---

## 故障排除

### ESP32 鏡頭沒畫面
- 在「no signal」狀態按 **↻ RECONNECT**(中央大鈕)
- 還是不行 → ESP32 拔電重插。Boot ~10s 後 dashboard 應該自動回來
- 還是不行 → 看 OLED:有數字 = ESP32 活著,可能 :81/stream 被前一個訪客的瀏覽器卡住,F5 整個頁面
- 全死 → 看本文末段「冷重啟」

### 溫度 / 濕度沒進來,但鏡頭有畫面
- ESP32 上的 OLED 還在跑嗎?有就是 dashboard 沒收到 SSE → F5 頁面
- OLED 也死了 → DHT11 鬆掉,輕推一下接線,或重燒韌體

### Vision SCAN 按下去無反應 / 紅字錯誤
- 紅字「vision agent unavailable」= Ollama 沒回應。Powershell 跑:
  ```powershell
  ollama list      # 確認 qwen2.5vl:3b 還在
  ollama ps        # 確認沒卡住
  ```
- 還沒復原 → `ollama serve` 重啟一次 Ollama 服務
- 持續失敗 → 接受展示沒有 SCAN 功能,demo 其他部分照跑

### Servo 拖了但鏡頭不轉
- 角度欄位卡黃色 = 命令沒送到 → 看 ESP32 是否在線(OLED 還在跳就在線)
- ESP32 在線 → 點 ↻ RECONNECT,再拖一次
- 還是不轉 → SG90 偶爾要 5V 1A 才動,USB 5V 不夠;接外接 5V

### 整個 dashboard 變白頁 / 沒反應
- F5(Ctrl+F5 強制重整)
- 還是死 → `.\scripts\stop-demo.ps1` 然後 `.\scripts\start-booth.ps1`

### Firefox kiosk 不見了 / 訪客誤關了
- 任何 PowerShell 視窗跑 `.\scripts\start-booth.ps1` 重來
- 或直接命令列:`firefox.exe --kiosk http://127.0.0.1:18790/?token=<token>`

---

## 下班 — 一鍵關閉

```powershell
.\scripts\stop-demo.ps1
```

- 把 gateway / bridge / 任何掛著的 :18790 / :8765 process kill
- Firefox kiosk 不會自動關,自己 Alt+F4 即可
- ESP32 拔電就好

---

## 冷重啟(最後手段)

如果上面都救不回:

```powershell
# 1) 殺所有 demo2 相關 process
.\scripts\stop-demo.ps1
Get-Process | Where-Object { $_.ProcessName -match "openclaw|node|firefox" } | Stop-Process -Force

# 2) ESP32 拔 USB → 等 5 秒 → 接回

# 3) 重新一鍵啟動
.\scripts\start-booth.ps1
```

從零到 dashboard 在 Firefox 上跑,大約 30-40 秒。

---

## 關鍵檔案速查

| 檔案 | 用途 |
|---|---|
| `scripts/start-booth.ps1` | 一鍵啟動(這個) |
| `scripts/start-demo.ps1`  | 啟動但不開 Firefox(dev / mock 用) |
| `scripts/stop-demo.ps1`   | 一鍵停止 |
| `arduino/esp32_sensor_node/secrets.h` | WiFi / token / PC IP — **gitignore,換場一定要改** |
| `.env.local`              | gateway token,bootstrap-profile.ps1 自動產 |
| `~/.openclaw-strixdemo2/` | OpenClaw profile + plugin install 位置 |
| `docs/WIRING-ESP32.md`    | 接線圖(換板子時看) |

---

## 換場 checklist(換新環境前 5 分鐘做)

- [ ] WiFi:確認 phone hotspot 開、SSID 跟 `secrets.h` 一致
- [ ] Surface 連上同一個 WiFi(右下角 WiFi icon)
- [ ] `ipconfig` 看 Surface 的 LAN IP,跟 `secrets.h` 的 `PC_HOST` 對得起來
- [ ] firewall 規則「demo2 OpenClaw gateway 18790」還在(`Get-NetFirewallRule -DisplayName "demo2*"`)
- [ ] ESP32 通電 → OLED 出畫面 → seq 計數有在跳(代表它在 POST)
- [ ] dashboard 右下 QR 出現(代表 plugin 認得到 LAN IP)
- [ ] 自己手機掃一下 QR,連得進來 → confirmation
