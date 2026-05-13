/*
 * demo2 — Component Test (Phase 1 + Phase 2 hardware)
 * Board: GOOUUU ESP32-S3-CAM-N16R8 (OV2640)
 *
 * Interactive Serial menu — exercises every demo2 component in isolation so
 * you can verify wiring before flashing the production sketch. Phase 2 tests
 * only init their pins on first invocation, so you can run this sketch even
 * if you haven't wired Phase 2 yet (those menu items just fail diagnostically).
 *
 * Arduino IDE Settings:
 *   Board:                "ESP32S3 Dev Module"
 *   USB CDC On Boot:      "Enabled"
 *   PSRAM:                "OPI PSRAM"
 *   Flash Size:           "16MB"
 *   Partition Scheme:     "Huge APP (3MB No OTA/1MB SPIFFS)"
 *
 * Libraries (Manage Libraries → install):
 *   - DHT sensor library (Adafruit)
 *   - Adafruit Unified Sensor (DHT dependency, usually auto-pulled)
 *   - U8g2 (Oliver Kraus)
 *
 * Pin map — Phase 1 (already wired from prior project):
 *   DHT11        Data → GPIO 2,  VCC → 3.3V, GND → GND
 *   Servo Pan    Sig  → GPIO 14, VCC → 5V,   GND → GND
 *   Servo Tilt   Sig  → GPIO 3,  VCC → 5V,   GND → GND
 *   OLED SH1106  SDA  → GPIO 47, SCL → GPIO 48, VCC → 3.3V, GND → GND
 *   INMP441 mic  SCK  → GPIO 38, WS  → GPIO 39, SD → GPIO 40, L/R → GND, VDD → 3.3V
 *   OV2640       fixed (see camera pin block below)
 *
 * Pin map — Phase 2 (incremental: wire ONE component, test, repeat):
 *   PIR HC-SR501 OUT  → GPIO 21,  VCC → 5V, GND → GND
 *   HC-SR04 Trig      → GPIO 42, VCC → 5V, GND → GND
 *   HC-SR04 Echo      → GPIO 41 via 5V→3.3V divider (1kΩ→GPIO 41, GPIO 41→2kΩ→GND)
 *   Buzzer (active) + → GPIO 45, − → GND
 *   LED red anode     → GPIO 1 via 220Ω series, cathode → GND
 *
 * (LDR was dropped from the Phase 2 BOM — not applicable to the booth scene.)
 *
 * Usage:
 *   Serial Monitor at 115200 baud. Type one of:
 *     Phase 1:
 *       1 = DHT11        2 = Servo Pan    3 = Servo Tilt
 *       4 = Camera       5 = WiFi         6 = Servo sweep
 *       7 = Test ALL P1  8 = OLED         9 = OLED live
 *       m = mic RMS
 *     Phase 2:
 *       p = PIR live     d = HC-SR04 distance live
 *       b = buzzer beep  e = LED blink
 *     control:
 *       s = stop any running loop
 */

#include <WiFi.h>
#include <Wire.h>
#include <DHT.h>
#include <U8g2lib.h>
#include <driver/i2s.h>
#include "esp_camera.h"

// ============================================================================
// Pin configuration (Phase 1)
// ============================================================================
#define SERVO_PAN_PIN   14
#define SERVO_TILT_PIN   3
#define DHT_PIN          2
#define DHT_TYPE       DHT11

// OLED SH1106 1.3" (NOT SSD1306 — different controller, same I2C addr)
#define OLED_SDA        47
#define OLED_SCL        48
U8G2_SH1106_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);
bool oledReady = false;

// INMP441 I2S microphone
#define I2S_SCK    38
#define I2S_WS     39
#define I2S_SD     40
#define I2S_PORT   I2S_NUM_0
#define I2S_SAMPLE_RATE 16000
#define I2S_BUF_LEN      512
bool micReady = false;

// ============================================================================
// Pin configuration (Phase 2 — only init when the corresponding test runs,
// so an un-wired pin floating doesn't break Phase 1 boot)
// ============================================================================
#define PIR_PIN          21    // HC-SR501 OUT (3.3V level, direct connect)
#define HCSR_TRIG_PIN    42    // HC-SR04 Trig (3.3V is enough for trig)
#define HCSR_ECHO_PIN    41    // HC-SR04 Echo via 5V→3.3V divider (1kΩ + 2kΩ to GND)
#define BUZZER_PIN       45    // Active buzzer + (GPIO 43 not broken out, 45 is)
#define LED_PIN           1    // LED red anode (+ 220Ω to LED, LED → GND)
// (LDR removed from BOM; GPIO 1 reused for LED.)

// Camera (GOOUUU ESP32-S3-CAM)
#define PWDN_GPIO_NUM  -1
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM  15
#define SIOD_GPIO_NUM   4
#define SIOC_GPIO_NUM   5
#define Y9_GPIO_NUM    16
#define Y8_GPIO_NUM    17
#define Y7_GPIO_NUM    18
#define Y6_GPIO_NUM    12
#define Y5_GPIO_NUM    10
#define Y4_GPIO_NUM     8
#define Y3_GPIO_NUM     9
#define Y2_GPIO_NUM    11
#define VSYNC_GPIO_NUM  6
#define HREF_GPIO_NUM   7
#define PCLK_GPIO_NUM  13

// Servo PWM
#define SERVO_FREQ       50
#define SERVO_RESOLUTION 14
#define SERVO_MIN_US    500
#define SERVO_MAX_US   2400

// WiFi (only used by the WiFi test option — overridden if secrets.h available)
const char* WIFI_SSID     = "your_wifi_ssid";
const char* WIFI_PASSWORD = "your_wifi_password";

// ============================================================================
// State
// ============================================================================
DHT dht(DHT_PIN, DHT_TYPE);
bool cameraReady = false;
bool running     = false;       // shared "stop me" flag for sweep / live / mic
float panAngle   = 90.0;
float tiltAngle  = 90.0;

// ============================================================================
// Helpers
// ============================================================================
void servoWrite(int pin, float angle) {
    angle = constrain(angle, 0, 180);
    uint32_t pulseUs = map((long)(angle * 10), 0, 1800, SERVO_MIN_US, SERVO_MAX_US);
    uint32_t maxDuty = (1u << SERVO_RESOLUTION) - 1;
    uint32_t duty    = (pulseUs * maxDuty) / 20000;
    ledcWrite(pin, duty);
    if (pin == SERVO_PAN_PIN)  panAngle  = angle;
    if (pin == SERVO_TILT_PIN) tiltAngle = angle;
    Serial.printf("  Pin %d -> angle=%.0f pulse=%uus duty=%u/%u\n",
                  pin, angle, pulseUs, duty, maxDuty);
}

bool stopRequested() {
    if (Serial.available()) {
        char c = Serial.read();
        if (c == 's' || c == 'S') {
            running = false;
            // Flush rest of line.
            while (Serial.available()) Serial.read();
            return true;
        }
    }
    return false;
}

// ============================================================================
// Test: DHT11
// ============================================================================
void testDHT11() {
    Serial.println("\n===== TEST: DHT11 (GPIO 2) =====");
    for (int i = 0; i < 3; i++) {
        float h = dht.readHumidity();
        float t = dht.readTemperature();
        if (isnan(h) || isnan(t)) {
            Serial.printf("  [%d] FAIL — NaN. Check: 3.3V VCC, data on GPIO 2, 4.7kΩ pull-up to 3.3V.\n", i + 1);
        } else {
            Serial.printf("  [%d] OK — Temp=%.1f°C Humidity=%.1f%%\n", i + 1, t, h);
        }
        delay(2200); // DHT11 needs ≥2s between reads
    }
    Serial.println("===== DHT11 done =====\n");
}

// ============================================================================
// Test: Servos
// ============================================================================
void testServo(int pin, const char* name, int leftAngle, int rightAngle) {
    Serial.printf("\n===== TEST: Servo %s (GPIO %d) =====\n", name, pin);
    Serial.println("  Center → low → high → center");
    servoWrite(pin, 90);         delay(800);
    servoWrite(pin, leftAngle);  delay(800);
    servoWrite(pin, rightAngle); delay(800);
    servoWrite(pin, 90);         delay(400);
    Serial.println("  Did it move? If not: 5V power, signal wire, jitter-free GND.");
    Serial.printf("===== Servo %s done =====\n\n", name);
}

void servoSweep() {
    Serial.println("\n===== Servo Pan sweep — type 's' to stop =====");
    running = true;
    while (running) {
        for (int a = 30; a <= 150 && running; a += 5) {
            servoWrite(SERVO_PAN_PIN, a);
            delay(80);
            if (stopRequested()) break;
        }
        for (int a = 150; a >= 30 && running; a -= 5) {
            servoWrite(SERVO_PAN_PIN, a);
            delay(80);
            if (stopRequested()) break;
        }
    }
    servoWrite(SERVO_PAN_PIN, 90);
    Serial.println("===== Sweep stopped =====\n");
}

// ============================================================================
// Test: Camera
// ============================================================================
bool initCamera() {
    if (cameraReady) return true;
    camera_config_t c = {};
    c.ledc_channel = LEDC_CHANNEL_0;
    c.ledc_timer   = LEDC_TIMER_0;
    c.pin_d0 = Y2_GPIO_NUM; c.pin_d1 = Y3_GPIO_NUM;
    c.pin_d2 = Y4_GPIO_NUM; c.pin_d3 = Y5_GPIO_NUM;
    c.pin_d4 = Y6_GPIO_NUM; c.pin_d5 = Y7_GPIO_NUM;
    c.pin_d6 = Y8_GPIO_NUM; c.pin_d7 = Y9_GPIO_NUM;
    c.pin_xclk     = XCLK_GPIO_NUM;
    c.pin_pclk     = PCLK_GPIO_NUM;
    c.pin_vsync    = VSYNC_GPIO_NUM;
    c.pin_href     = HREF_GPIO_NUM;
    c.pin_sccb_sda = SIOD_GPIO_NUM;
    c.pin_sccb_scl = SIOC_GPIO_NUM;
    c.pin_pwdn     = PWDN_GPIO_NUM;
    c.pin_reset    = RESET_GPIO_NUM;
    c.xclk_freq_hz = 20000000;
    c.pixel_format = PIXFORMAT_JPEG;
    c.frame_size   = FRAMESIZE_VGA;
    c.jpeg_quality = 12;
    c.fb_count     = 1;
    c.fb_location  = CAMERA_FB_IN_PSRAM;
    c.grab_mode    = CAMERA_GRAB_LATEST;
    esp_err_t err = esp_camera_init(&c);
    if (err != ESP_OK) {
        Serial.printf("  Camera init FAIL: 0x%x — check PSRAM=OPI, Flash=16MB.\n", err);
        return false;
    }
    cameraReady = true;
    return true;
}

void testCamera() {
    Serial.println("\n===== TEST: Camera (OV2640) =====");
    if (!initCamera()) {
        Serial.println("===== Camera done (init failed) =====\n");
        return;
    }
    camera_fb_t* fb = esp_camera_fb_get();
    if (!fb) {
        Serial.println("  Capture FAIL");
    } else {
        Serial.printf("  OK — %dx%d %u bytes\n", fb->width, fb->height, fb->len);
        esp_camera_fb_return(fb);
    }
    Serial.printf("  Heap free=%u  PSRAM free=%u/%u\n",
                  ESP.getFreeHeap(), ESP.getFreePsram(), ESP.getPsramSize());
    Serial.println("===== Camera done =====\n");
}

// ============================================================================
// Test: WiFi
// ============================================================================
void testWiFi() {
    Serial.println("\n===== TEST: WiFi =====");
    Serial.printf("  SSID: %s\n", WIFI_SSID);
    if (strcmp(WIFI_SSID, "your_wifi_ssid") == 0) {
        Serial.println("  (Skip — edit WIFI_SSID/WIFI_PASSWORD at the top of this sketch to test.)");
        Serial.println("===== WiFi done =====\n");
        return;
    }
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    Serial.print("  Connecting");
    for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) {
        delay(500);
        Serial.print(".");
    }
    Serial.println();
    if (WiFi.status() == WL_CONNECTED) {
        Serial.printf("  OK — IP=%s RSSI=%d\n",
                      WiFi.localIP().toString().c_str(), WiFi.RSSI());
    } else {
        Serial.println("  FAIL — 2.4GHz only? SSID / password right?");
    }
    WiFi.disconnect();
    Serial.println("===== WiFi done =====\n");
}

// ============================================================================
// Test: OLED
// ============================================================================
bool initOLED() {
    if (oledReady) return true;
    Wire.begin(OLED_SDA, OLED_SCL);
    u8g2.setBusClock(400000);
    if (!u8g2.begin()) {
        Serial.println("  OLED init FAIL — check SDA=47 SCL=48, 3.3V, address 0x3C.");
        return false;
    }
    oledReady = true;
    return true;
}

void testOLED() {
    Serial.println("\n===== TEST: OLED SH1106 1.3\" (GPIO 47/48) =====");
    if (!initOLED()) {
        Serial.println("===== OLED done (init failed) =====\n");
        return;
    }
    u8g2.clearBuffer();
    u8g2.setFont(u8g2_font_6x10_tr);
    u8g2.drawStr(0, 10, "demo2 sensor node");
    u8g2.drawLine(0, 12, 128, 12);
    u8g2.drawStr(0, 26, "OLED OK");
    u8g2.setFont(u8g2_font_10x20_tr);
    u8g2.drawStr(20, 50, "Hello!");
    u8g2.sendBuffer();
    delay(1800);

    for (int i = 0; i <= 100; i += 5) {
        u8g2.clearBuffer();
        u8g2.setFont(u8g2_font_6x10_tr);
        u8g2.drawStr(30, 20, "loading...");
        u8g2.drawFrame(14, 30, 100, 14);
        u8g2.drawBox(14, 30, i, 14);
        u8g2.sendBuffer();
        delay(40);
    }
    Serial.println("  OK — text + progress bar shown.");
    Serial.println("===== OLED done =====\n");
}

void oledLiveSensor() {
    Serial.println("\n===== OLED live (temp/hum + uptime) — type 's' to stop =====");
    if (!initOLED()) {
        Serial.println("  (OLED init failed)");
        return;
    }
    running = true;
    unsigned long start = millis();
    char buf[32];
    while (running) {
        float h = dht.readHumidity();
        float t = dht.readTemperature();
        unsigned long up = (millis() - start) / 1000;
        u8g2.clearBuffer();
        u8g2.setFont(u8g2_font_6x10_tr);
        u8g2.drawStr(0, 10, "demo2 sensor node");
        u8g2.drawLine(0, 12, 128, 12);
        if (!isnan(h) && !isnan(t)) {
            u8g2.drawStr(0, 26, "Temp:");
            u8g2.setFont(u8g2_font_10x20_tr);
            snprintf(buf, sizeof(buf), "%.1fC", t);
            u8g2.drawStr(40, 28, buf);
            u8g2.setFont(u8g2_font_6x10_tr);
            u8g2.drawStr(0, 44, "Hum :");
            u8g2.setFont(u8g2_font_10x20_tr);
            snprintf(buf, sizeof(buf), "%.1f%%", h);
            u8g2.drawStr(40, 46, buf);
        } else {
            u8g2.drawStr(0, 28, "DHT11: reading...");
        }
        u8g2.setFont(u8g2_font_6x10_tr);
        snprintf(buf, sizeof(buf), "Pan:%.0f Tilt:%.0f %lus",
                 panAngle, tiltAngle, up);
        u8g2.drawStr(0, 62, buf);
        u8g2.sendBuffer();
        for (int i = 0; i < 10 && running; i++) {
            delay(200);
            stopRequested();
        }
    }
    u8g2.clearBuffer();
    u8g2.setFont(u8g2_font_6x10_tr);
    u8g2.drawStr(30, 35, "Stopped.");
    u8g2.sendBuffer();
    Serial.println("===== OLED live stopped =====\n");
}

// ============================================================================
// Test: INMP441 mic (RMS volume meter)
// ============================================================================
bool initMic() {
    if (micReady) return true;
    i2s_config_t cfg = {
        .mode                 = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
        .sample_rate          = I2S_SAMPLE_RATE,
        .bits_per_sample      = I2S_BITS_PER_SAMPLE_32BIT,
        .channel_format       = I2S_CHANNEL_FMT_ONLY_LEFT,
        .communication_format = I2S_COMM_FORMAT_STAND_I2S,
        .intr_alloc_flags     = ESP_INTR_FLAG_LEVEL1,
        .dma_buf_count        = 4,
        .dma_buf_len          = I2S_BUF_LEN,
        .use_apll             = false,
        .tx_desc_auto_clear   = false,
        .fixed_mclk           = 0,
    };
    i2s_pin_config_t pins = {
        .bck_io_num   = I2S_SCK,
        .ws_io_num    = I2S_WS,
        .data_out_num = I2S_PIN_NO_CHANGE,
        .data_in_num  = I2S_SD,
    };
    if (i2s_driver_install(I2S_PORT, &cfg, 0, NULL) != ESP_OK ||
        i2s_set_pin(I2S_PORT, &pins) != ESP_OK) {
        Serial.println("  I2S init FAIL — check SCK=38 WS=39 SD=40, L/R→GND, VDD=3.3V.");
        return false;
    }
    micReady = true;
    return true;
}

void testMic() {
    Serial.println("\n===== TEST: INMP441 RMS (GPIO 38/39/40) — type 's' to stop =====");
    if (!initMic()) {
        Serial.println("===== Mic done (init failed) =====\n");
        return;
    }
    int32_t samples[I2S_BUF_LEN];
    size_t  bytesRead = 0;
    running = true;
    int count = 0;
    while (running) {
        i2s_read(I2S_PORT, samples, sizeof(samples), &bytesRead, portMAX_DELAY);
        int n = bytesRead / sizeof(int32_t);
        if (n == 0) continue;
        int64_t sum    = 0;
        int32_t maxRaw = INT32_MIN;
        int32_t minRaw = INT32_MAX;
        for (int i = 0; i < n; i++) {
            int32_t s = samples[i] >> 8;
            sum += (int64_t)s * s;
            if (samples[i] > maxRaw) maxRaw = samples[i];
            if (samples[i] < minRaw) minRaw = samples[i];
        }
        float rms   = sqrtf((float)sum / n);
        int   level = map(constrain((int)(rms / 100), 0, 3000), 0, 3000, 0, 30);
        if (++count % 5 == 0) {
            Serial.printf("  Vol [");
            for (int i = 0; i < 30; i++) Serial.print(i < level ? '#' : ' ');
            Serial.printf("] RMS=%8.0f  raw min=%d max=%d\n", rms, minRaw, maxRaw);
        }
        stopRequested();
    }
    i2s_driver_uninstall(I2S_PORT);
    micReady = false;
    Serial.println("===== Mic done =====\n");
}

// ============================================================================
// Phase 2: PIR HC-SR501 — motion detector live monitor
// ============================================================================
void testPIR() {
    Serial.println("\n===== TEST: PIR HC-SR501 (GPIO 21) — 's' to stop =====");
    Serial.println("  HC-SR501 needs ~30s settling after power-on before it's stable.");
    Serial.println("  Wave a hand 1-3m in front of the lens; pin should go HIGH for ~3-5s.");
    Serial.println("  If always LOW: check 5V to PIR VCC, OUT wire to GPIO 21, jumper set to H.");
    Serial.println();
    pinMode(PIR_PIN, INPUT);
    running = true;
    int last = -1;
    unsigned long startMs = millis();
    int transitions = 0;
    while (running) {
        int now = digitalRead(PIR_PIN);
        if (now != last) {
            unsigned long t = (millis() - startMs) / 1000;
            Serial.printf("  [t+%lus] PIR = %s  (transitions=%d)\n",
                          t, now == HIGH ? "HIGH (motion!)" : "LOW  (idle)", ++transitions);
            last = now;
        }
        for (int i = 0; i < 5 && running; i++) {
            delay(40);
            stopRequested();
        }
    }
    Serial.printf("  PIR test done. %d transitions in %lus.\n",
                  transitions, (millis() - startMs) / 1000);
    Serial.println("===== PIR done =====\n");
}

// ============================================================================
// Phase 2: HC-SR04 — ultrasonic distance live read
// ============================================================================
float readDistanceCm() {
    digitalWrite(HCSR_TRIG_PIN, LOW);
    delayMicroseconds(2);
    digitalWrite(HCSR_TRIG_PIN, HIGH);
    delayMicroseconds(10);
    digitalWrite(HCSR_TRIG_PIN, LOW);
    // 30ms timeout ≈ 5m max range; out-of-range returns 0
    unsigned long pulseUs = pulseIn(HCSR_ECHO_PIN, HIGH, 30000UL);
    if (pulseUs == 0) return -1.0f;            // no echo
    return (float)pulseUs * 0.0343f / 2.0f;    // speed of sound / 2 (round-trip)
}

void testDistance() {
    Serial.println("\n===== TEST: HC-SR04 distance (GPIO 42 trig / 41 echo) — 's' to stop =====");
    Serial.println("  Sample every 200ms. Move your hand 5cm-2m in front of the sensor.");
    Serial.println("  If always -1: check 5V to VCC, trig wire, echo voltage divider (5V→3.3V).");
    Serial.println("  If always 999/erratic: divider missing or HC-SR04 damaged.");
    Serial.println();
    pinMode(HCSR_TRIG_PIN, OUTPUT);
    pinMode(HCSR_ECHO_PIN, INPUT);
    digitalWrite(HCSR_TRIG_PIN, LOW);
    delay(100);
    running = true;
    int count = 0;
    float lastReported = -999.0f;
    while (running) {
        float cm = readDistanceCm();
        count++;
        // Print every reading for the first 5, then every change > 2cm OR every 10th
        bool report = count <= 5
                   || count % 10 == 0
                   || (cm > 0 && fabsf(cm - lastReported) > 2.0f);
        if (report) {
            if (cm < 0) {
                Serial.printf("  [%4d] distance = no echo (out of range / wiring issue)\n", count);
            } else {
                Serial.printf("  [%4d] distance = %6.1f cm\n", count, cm);
                lastReported = cm;
            }
        }
        for (int i = 0; i < 5 && running; i++) {
            delay(40);
            stopRequested();
        }
    }
    Serial.printf("  Distance test done. %d samples taken.\n", count);
    Serial.println("===== Distance done =====\n");
}

// ============================================================================
// Phase 2: Buzzer + LED — quick beep / blink
// ============================================================================
void testBuzzer() {
    Serial.println("\n===== TEST: Buzzer (GPIO 45) =====");
    Serial.println("  3 beeps, 300ms each. Active buzzer should make audible sound.");
    pinMode(BUZZER_PIN, OUTPUT);
    for (int i = 0; i < 3; i++) {
        digitalWrite(BUZZER_PIN, HIGH);
        Serial.printf("  beep %d ON\n", i + 1);
        delay(300);
        digitalWrite(BUZZER_PIN, LOW);
        delay(300);
    }
    Serial.println("  If silent: passive buzzer (needs PWM), wire to wrong polarity, or GPIO 43 issue.");
    Serial.println("===== Buzzer done =====\n");
}

void testLED() {
    Serial.println("\n===== TEST: LED (GPIO 1) =====");
    Serial.println("  Blink 5 times, 250ms on / 250ms off. With 220Ω series resistor it'll be dim-ish.");
    pinMode(LED_PIN, OUTPUT);
    for (int i = 0; i < 5; i++) {
        digitalWrite(LED_PIN, HIGH);
        Serial.printf("  LED on  (%d)\n", i + 1);
        delay(250);
        digitalWrite(LED_PIN, LOW);
        delay(250);
    }
    Serial.println("  Off. If never lit: check anode/cathode (long leg = +), 220Ω in series.");
    Serial.println("===== LED done =====\n");
}

// ============================================================================
// Test ALL
// ============================================================================
void testAll() {
    Serial.println("\n##############################");
    Serial.println("# RUNNING ALL TESTS          #");
    Serial.println("##############################\n");
    testDHT11();
    testServo(SERVO_PAN_PIN,  "Pan",  30, 150);
    testServo(SERVO_TILT_PIN, "Tilt", 60, 120);
    testCamera();
    testWiFi();
    testOLED();
    Serial.println("(Mic test skipped from ALL — run 'm' manually for the live meter.)");
    Serial.println("\n##############################");
    Serial.println("# ALL TESTS COMPLETE         #");
    Serial.println("##############################\n");
}

// ============================================================================
// Menu
// ============================================================================
void printMenu() {
    Serial.println("================================");
    Serial.println("  demo2 Component Test");
    Serial.println("================================");
    Serial.println("  -- Phase 1 --");
    Serial.println("  1 = DHT11 (temp/humidity)");
    Serial.println("  2 = Servo Pan  (GPIO 14)");
    Serial.println("  3 = Servo Tilt (GPIO 3)");
    Serial.println("  4 = Camera (init + 1 frame)");
    Serial.println("  5 = WiFi connect");
    Serial.println("  6 = Servo Pan sweep");
    Serial.println("  7 = Test ALL Phase 1");
    Serial.println("  8 = OLED display");
    Serial.println("  9 = OLED live sensor");
    Serial.println("  m = INMP441 mic RMS meter");
    Serial.println("  -- Phase 2 --");
    Serial.println("  p = PIR HC-SR501 (GPIO 21) — motion live");
    Serial.println("  d = HC-SR04 distance (GPIO 42/41) — cm live");
    Serial.println("  b = Buzzer (GPIO 45) — 3 beeps");
    Serial.println("  e = LED (GPIO 1) — 5 blinks");
    Serial.println("  -- control --");
    Serial.println("  s = Stop any running loop");
    Serial.println("================================");
    Serial.print("> ");
}

// ============================================================================
// setup / loop
// ============================================================================
void setup() {
    Serial.begin(115200);
    delay(800);
    Serial.println("\n=== demo2 ESP32-S3-CAM Component Tester (Phase 1) ===");

    dht.begin();
    Serial.println("DHT11 driver ready (GPIO 2)");

    ledcAttach(SERVO_PAN_PIN,  SERVO_FREQ, SERVO_RESOLUTION);
    ledcAttach(SERVO_TILT_PIN, SERVO_FREQ, SERVO_RESOLUTION);
    servoWrite(SERVO_PAN_PIN,  90);
    servoWrite(SERVO_TILT_PIN, 90);
    Serial.println("Servos centered (Pan=14, Tilt=3)");

    Serial.println();
    printMenu();
}

void loop() {
    if (!Serial.available()) return;
    char cmd = Serial.read();
    while (Serial.available()) Serial.read(); // flush
    switch (cmd) {
        case '1': testDHT11();                                printMenu(); break;
        case '2': testServo(SERVO_PAN_PIN,  "Pan",  30, 150); printMenu(); break;
        case '3': testServo(SERVO_TILT_PIN, "Tilt", 60, 120); printMenu(); break;
        case '4': testCamera();                               printMenu(); break;
        case '5': testWiFi();                                 printMenu(); break;
        case '6': servoSweep();                               printMenu(); break;
        case '7': testAll();                                  printMenu(); break;
        case '8': testOLED();                                 printMenu(); break;
        case '9': oledLiveSensor();                           printMenu(); break;
        case 'm': case 'M': testMic();                        printMenu(); break;
        case 'p': case 'P': testPIR();                        printMenu(); break;
        case 'd': case 'D': testDistance();                   printMenu(); break;
        case 'b': case 'B': testBuzzer();                     printMenu(); break;
        case 'e': case 'E': testLED();                        printMenu(); break;
        case 's': case 'S': running = false;                              break;
        case '\r': case '\n': case ' ': /* swallow */                     break;
        default:
            Serial.printf("unknown cmd '%c' — try one of 1-9 / m / p / d / b / e / s\n", cmd);
            printMenu();
            break;
    }
}
