/*
 * demo2 — ESP32-S3-CAM Sensor Node (Phase 1)
 * Board: GOOUUU ESP32-S3-CAM-N16R8 (OV2640)
 *
 * Phase 1 hardware (carried over from the prior 20260308_esp32_wifi_tracker
 * project — wiring is already done):
 *   DHT11        Data → GPIO 2,  VCC → 3.3V, GND → GND  (+ 4.7kΩ pull-up to 3.3V)
 *   Servo Pan    Sig  → GPIO 14, VCC → 5V,   GND → GND
 *   Servo Tilt   Sig  → GPIO 3,  VCC → 5V,   GND → GND
 *   OLED SH1106  SDA  → GPIO 47, SCL → GPIO 48, VCC → 3.3V, GND → GND
 *   INMP441 mic  SCK  → GPIO 38, WS  → GPIO 39, SD → GPIO 40, L/R → GND, VDD → 3.3V
 *   OV2640 cam   fixed pins (see camera pin block)
 *
 * Phase 2 hardware (added incrementally — only wires what's actually present):
 *   PIR HC-SR501 OUT → GPIO 21, VCC → 5V, GND → GND
 *   HC-SR04 Trig    → GPIO 42, VCC → 5V, GND → GND
 *   HC-SR04 Echo    → GPIO 41 via 5V→3.3V divider (1kΩ + 2kΩ to GND)
 *   Buzzer (active) + → GPIO 45 (GPIO 43 not broken out on this board)
 *   LED red anode → GPIO 1 via 220Ω (LDR removed from BOM — slot reused)
 *
 * What this sketch does:
 *   - 1Hz sample → POST JSON sensor frame to the demo2 plugin
 *     {ts, seq, temp_c, humidity, audio_rms, pan_angle, tilt_angle,
 *      device_ip, device_id}
 *   - HTTP server on :80 — /, /cmd, /capture
 *   - HTTP server on :81 — /stream (MJPEG, consumed by dashboard CameraCard)
 *   - OLED shows live temp/hum/IP/seq/uptime + last servo angles
 *   - /cmd accepts:
 *       {device:"servo",  state:"pan"|"tilt", angle:0..180}   ← Phase 1 working
 *       {device:"buzzer", state:"on"|"off", duration_ms?:N}   ← Phase 2 stub
 *       {device:"led",    state:"on"|"off"|"red"|"green"|...} ← Phase 2 stub
 *
 * Arduino IDE Settings:
 *   Board:            "ESP32S3 Dev Module"
 *   USB CDC On Boot:  "Disabled"   (USB stays for upload only; GPIO 19/20 free)
 *   Flash Size:       "16MB"
 *   PSRAM:            "OPI PSRAM"
 *   Partition Scheme: "Huge APP (3MB No OTA/1MB SPIFFS)"
 *
 * Libraries:
 *   - DHT sensor library (Adafruit)
 *   - Adafruit Unified Sensor (DHT dependency)
 *   - U8g2 (Oliver Kraus)
 *
 * Configuration: copy secrets.h.example to secrets.h and fill in.
 */

#include "secrets.h"

#include <WiFi.h>
#include <Wire.h>
#include <HTTPClient.h>
#include <DHT.h>
#include <U8g2lib.h>
#include <driver/i2s.h>
#include "esp_camera.h"
#include "esp_http_server.h"
#include "time.h"

// ============================================================================
// Pin map (Phase 1)
// ============================================================================
#define DHT_PIN           2
#define DHT_TYPE          DHT11

#define SERVO_PAN_PIN    14
#define SERVO_TILT_PIN    3

#define OLED_SDA         47
#define OLED_SCL         48

#define I2S_MIC_SCK      38
#define I2S_MIC_WS       39
#define I2S_MIC_SD       40
#define I2S_MIC_PORT     I2S_NUM_0
#define I2S_MIC_RATE   16000
#define I2S_MIC_BUFLEN   256

// Phase 2 (incremental — only enabled sensors get read in postSensorFrame):
#define PIN_PIR        21    // HC-SR501 OUT — 3.3V level, direct connect
#define PIN_HCSR_TRIG  42    // HC-SR04 trig
#define PIN_HCSR_ECHO  41    // HC-SR04 echo via 5V→3.3V divider (1kΩ + 2kΩ to GND)
#define PIN_BUZZER     45    // Active buzzer + — strapping pin, OK as output post-boot
#define PIN_LED         1    // LED red anode (via 220Ω). LDR slot reused.

// Camera (GOOUUU ESP32-S3-CAM)
#define PWDN_GPIO_NUM   -1
#define RESET_GPIO_NUM  -1
#define XCLK_GPIO_NUM   15
#define SIOD_GPIO_NUM    4
#define SIOC_GPIO_NUM    5
#define Y9_GPIO_NUM     16
#define Y8_GPIO_NUM     17
#define Y7_GPIO_NUM     18
#define Y6_GPIO_NUM     12
#define Y5_GPIO_NUM     10
#define Y4_GPIO_NUM      8
#define Y3_GPIO_NUM      9
#define Y2_GPIO_NUM     11
#define VSYNC_GPIO_NUM   6
#define HREF_GPIO_NUM    7
#define PCLK_GPIO_NUM   13

// Servo PWM (ESP32 Arduino core 3.x: ledcAttach + ledcWrite by pin)
#define SERVO_FREQ        50
#define SERVO_RESOLUTION  14
#define SERVO_MIN_US     500
#define SERVO_MAX_US    2400

// ============================================================================
// Globals
// ============================================================================
DHT dht(DHT_PIN, DHT_TYPE);
U8G2_SH1106_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);

httpd_handle_t cmd_httpd    = NULL;
httpd_handle_t stream_httpd = NULL;

unsigned long lastSampleMs = 0;
unsigned long lastWifiCheck = 0;
unsigned long seq           = 0;
unsigned long buzzerOffAtMs = 0;     // 0 = idle. >0 = millis() to turn buzzer off.
const unsigned long SAMPLE_INTERVAL_MS = 1000;

float panAngle  = 90.0f;
float tiltAngle = 90.0f;

bool  oledReady = false;
bool  micReady  = false;

String deviceIp = "";

// Cache the latest reading so the OLED update and any future status endpoint
// can read it without doing another I2S/DHT round-trip.
volatile float lastTempC      = NAN;
volatile float lastHumidity   = NAN;
volatile float lastAudioRms   = 0.0f;
volatile bool  lastPostOk     = false;

// ============================================================================
// Servo helper
// ============================================================================
void servoWrite(int pin, float angle) {
    angle = constrain(angle, 0.0f, 180.0f);
    uint32_t pulseUs = map((long)(angle * 10), 0, 1800, SERVO_MIN_US, SERVO_MAX_US);
    uint32_t maxDuty = (1u << SERVO_RESOLUTION) - 1;
    uint32_t duty    = (pulseUs * maxDuty) / 20000;
    ledcWrite(pin, duty);
    if (pin == SERVO_PAN_PIN)  panAngle  = angle;
    if (pin == SERVO_TILT_PIN) tiltAngle = angle;
}

// ============================================================================
// OLED helpers
// ============================================================================
void oledInit() {
    Wire.begin(OLED_SDA, OLED_SCL);
    u8g2.setBusClock(400000);
    if (u8g2.begin()) {
        oledReady = true;
        u8g2.clearBuffer();
        u8g2.setFont(u8g2_font_6x10_tr);
        u8g2.drawStr(0, 10, "demo2 sensor node");
        u8g2.drawLine(0, 12, 128, 12);
        u8g2.drawStr(0, 30, "Booting...");
        u8g2.sendBuffer();
    } else {
        Serial.println("OLED init failed (continuing without display)");
    }
}

void oledRender() {
    if (!oledReady) return;
    char buf[32];
    u8g2.clearBuffer();

    // Header line
    u8g2.setFont(u8g2_font_6x10_tr);
    u8g2.drawStr(0, 10, "demo2 sensor node");
    u8g2.drawLine(0, 12, 128, 12);

    // Temp / hum block — big mono font
    if (!isnan(lastTempC) && !isnan(lastHumidity)) {
        u8g2.drawStr(0, 26, "T:");
        u8g2.setFont(u8g2_font_10x20_tr);
        snprintf(buf, sizeof(buf), "%.1fC", lastTempC);
        u8g2.drawStr(16, 28, buf);

        u8g2.setFont(u8g2_font_6x10_tr);
        u8g2.drawStr(70, 26, "H:");
        u8g2.setFont(u8g2_font_10x20_tr);
        snprintf(buf, sizeof(buf), "%.0f%%", lastHumidity);
        u8g2.drawStr(86, 28, buf);
    } else {
        u8g2.setFont(u8g2_font_6x10_tr);
        u8g2.drawStr(0, 28, "DHT11: reading...");
    }

    // Audio bar (8 segments)
    u8g2.setFont(u8g2_font_6x10_tr);
    u8g2.drawStr(0, 46, "Mic");
    int level = constrain((int)(lastAudioRms / 1500.0f * 8), 0, 8);
    for (int i = 0; i < 8; i++) {
        int x = 20 + i * 6;
        if (i < level) u8g2.drawBox(x, 38, 5, 8);
        else           u8g2.drawFrame(x, 38, 5, 8);
    }
    snprintf(buf, sizeof(buf), "P:%.0f T:%.0f", panAngle, tiltAngle);
    u8g2.drawStr(72, 46, buf);

    // Footer: IP + seq + WiFi indicator
    snprintf(buf, sizeof(buf), "%s %s seq=%lu",
             lastPostOk ? "OK" : "..",
             deviceIp.length() > 0 ? deviceIp.c_str() : "(no IP)",
             seq);
    u8g2.drawStr(0, 62, buf);

    u8g2.sendBuffer();
}

// ============================================================================
// Mic — non-blocking RMS over ~50ms snapshot.
// ============================================================================
void micInit() {
    i2s_config_t cfg = {
        .mode                 = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
        .sample_rate          = I2S_MIC_RATE,
        .bits_per_sample      = I2S_BITS_PER_SAMPLE_32BIT,
        .channel_format       = I2S_CHANNEL_FMT_ONLY_LEFT,
        .communication_format = I2S_COMM_FORMAT_STAND_I2S,
        .intr_alloc_flags     = ESP_INTR_FLAG_LEVEL1,
        .dma_buf_count        = 4,
        .dma_buf_len          = I2S_MIC_BUFLEN,
        .use_apll             = false,
        .tx_desc_auto_clear   = false,
        .fixed_mclk           = 0,
    };
    i2s_pin_config_t pins = {
        .bck_io_num   = I2S_MIC_SCK,
        .ws_io_num    = I2S_MIC_WS,
        .data_out_num = I2S_PIN_NO_CHANGE,
        .data_in_num  = I2S_MIC_SD,
    };
    if (i2s_driver_install(I2S_MIC_PORT, &cfg, 0, NULL) == ESP_OK &&
        i2s_set_pin(I2S_MIC_PORT, &pins) == ESP_OK) {
        micReady = true;
        Serial.println("INMP441 mic ready (GPIO 38/39/40)");
    } else {
        Serial.println("INMP441 mic init failed (continuing without audio_rms)");
    }
}

// HC-SR04 distance (cm). Returns 999.0 on timeout / out of range — rules
// engine treats that as "very far" so object_too_close won't fire on misreads.
float readDistanceCm() {
    digitalWrite(PIN_HCSR_TRIG, LOW);
    delayMicroseconds(2);
    digitalWrite(PIN_HCSR_TRIG, HIGH);
    delayMicroseconds(10);
    digitalWrite(PIN_HCSR_TRIG, LOW);
    unsigned long pulseUs = pulseIn(PIN_HCSR_ECHO, HIGH, 30000UL); // 30ms ≈ 5m
    if (pulseUs == 0) return 999.0f;
    return (float)pulseUs * 0.0343f / 2.0f;
}

float micReadRms() {
    if (!micReady) return 0.0f;
    static int32_t buf[I2S_MIC_BUFLEN];
    size_t bytesRead = 0;
    // 50ms timeout — at 16kHz that's plenty for one DMA buffer to fill.
    if (i2s_read(I2S_MIC_PORT, buf, sizeof(buf), &bytesRead,
                 50 / portTICK_PERIOD_MS) != ESP_OK) {
        return 0.0f;
    }
    int n = bytesRead / sizeof(int32_t);
    if (n == 0) return 0.0f;
    int64_t sum = 0;
    for (int i = 0; i < n; i++) {
        // INMP441 outputs 24-bit data in MSB of a 32-bit word; shift down for
        // a working-range integer. (>>8 keeps magnitude roughly comparable to
        // the component_test "RMS" numbers seen in the prev project log.)
        int32_t s = buf[i] >> 8;
        sum += (int64_t)s * s;
    }
    return sqrtf((float)sum / n);
}

// ============================================================================
// ISO 8601 UTC timestamp from NTP-synced clock.
// ============================================================================
void formatNowIso(char* buf, size_t len) {
    struct tm tm;
    if (!getLocalTime(&tm, 100)) {
        snprintf(buf, len, "1970-01-01T00:00:00.000Z");
        return;
    }
    snprintf(buf, len,
        "%04d-%02d-%02dT%02d:%02d:%02d.%03ldZ",
        tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday,
        tm.tm_hour, tm.tm_min, tm.tm_sec,
        (long)(millis() % 1000));
}

// ============================================================================
// 1Hz POST sensor frame to plugin
// ============================================================================
bool postSensorFrame() {
    float t = dht.readTemperature();
    float h = dht.readHumidity();
    if (!isnan(t)) lastTempC    = t;
    if (!isnan(h)) lastHumidity = h;
    float rms = micReadRms();
    lastAudioRms = rms;
    int   pir   = digitalRead(PIN_PIR) == HIGH ? 1 : 0;
    float dist  = readDistanceCm();
    seq++;

    char ts[32];
    formatNowIso(ts, sizeof(ts));

    // Build the JSON body. Use sentinel only if we never got a good reading;
    // otherwise carry the last-known value (DHT11 sporadically NaNs).
    float tOut = isnan(t) ? (isnan(lastTempC) ? -127.0f : lastTempC) : t;
    float hOut = isnan(h) ? (isnan(lastHumidity) ? -1.0f : lastHumidity) : h;

    char body[460];
    snprintf(body, sizeof(body),
        "{\"ts\":\"%s\",\"seq\":%lu,"
        "\"temp_c\":%.2f,\"humidity\":%.2f,"
        "\"audio_rms\":%.1f,"
        "\"pir\":%d,\"distance_cm\":%.1f,"
        "\"pan_angle\":%.1f,\"tilt_angle\":%.1f,"
        "\"device_ip\":\"%s\",\"device_id\":\"%s\"}",
        ts, seq, tOut, hOut, rms, pir, dist, panAngle, tiltAngle,
        deviceIp.c_str(), DEVICE_ID);

    HTTPClient http;
    String url = String("http://") + PC_HOST + ":18790/api/sensor/ingest";
    http.begin(url);
    http.setTimeout(2000);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("Authorization", String("Bearer ") + GATEWAY_TOKEN);
    int code = http.POST((uint8_t*)body, strlen(body));
    bool ok  = (code == 200);
    lastPostOk = ok;
    if (!ok) {
        Serial.printf("ingest POST failed code=%d url=%s\n", code, url.c_str());
    }
    http.end();
    return ok;
}

// ============================================================================
// /cmd handler — JSON
//   {device:"servo",  state:"pan"|"tilt", angle:NN}
//   {device:"buzzer", state:"on"|"off"}             ← Phase 2 stub (logs only)
//   {device:"led",    state:"on"|"off"|"red"|...}   ← Phase 2 stub (logs only)
// ============================================================================
static esp_err_t cmd_handler(httpd_req_t *req) {
    char buf[256];
    int total = req->content_len;
    if (total <= 0 || total > (int)sizeof(buf) - 1) {
        httpd_resp_set_status(req, "400 Bad Request");
        httpd_resp_sendstr(req, "{\"ok\":false,\"error\":\"bad body\"}");
        return ESP_OK;
    }
    int got = httpd_req_recv(req, buf, total);
    if (got <= 0) {
        httpd_resp_set_status(req, "400 Bad Request");
        httpd_resp_sendstr(req, "{\"ok\":false,\"error\":\"recv\"}");
        return ESP_OK;
    }
    buf[got] = 0;
    String body(buf);

    // Tiny key extractor — avoids ArduinoJson dependency.
    auto extractStr = [&](const String& key) -> String {
        int i = body.indexOf("\"" + key + "\"");
        if (i < 0) return "";
        int colon = body.indexOf(':', i);
        if (colon < 0) return "";
        int q1 = body.indexOf('"', colon + 1);
        if (q1 < 0) return "";
        int q2 = body.indexOf('"', q1 + 1);
        if (q2 < 0) return "";
        return body.substring(q1 + 1, q2);
    };
    auto extractNum = [&](const String& key) -> long {
        int i = body.indexOf("\"" + key + "\"");
        if (i < 0) return 0;
        int colon = body.indexOf(':', i);
        if (colon < 0) return 0;
        return atol(body.c_str() + colon + 1);
    };

    String device   = extractStr("device");
    String state    = extractStr("state");
    long   angle    = extractNum("angle");
    long   duration = extractNum("duration_ms");

    Serial.printf("/cmd device=%s state=%s angle=%ld duration=%ld\n",
                  device.c_str(), state.c_str(), angle, duration);

    bool handled = false;
    if (device == "servo") {
        if (state == "pan") {
            servoWrite(SERVO_PAN_PIN,  (float)angle);
            handled = true;
        } else if (state == "tilt") {
            servoWrite(SERVO_TILT_PIN, (float)angle);
            handled = true;
        }
    } else if (device == "buzzer") {
        if (state == "on") {
            digitalWrite(PIN_BUZZER, HIGH);
            // duration_ms=0 → stay on until explicit "off"; otherwise schedule
            // auto-off so a rule's burst doesn't leave the buzzer screaming.
            buzzerOffAtMs = duration > 0 ? millis() + duration : 0;
            handled = true;
        } else if (state == "off") {
            digitalWrite(PIN_BUZZER, LOW);
            buzzerOffAtMs = 0;
            handled = true;
        }
    } else if (device == "led") {
        // motion_detected rule sets state:"on"; other rules / dashboard may
        // send "off"|"red"|"green"|"blue". Our single LED is just on/off —
        // any color/on string lights it, "off" extinguishes.
        if (state == "off") {
            digitalWrite(PIN_LED, LOW);
            handled = true;
        } else {
            digitalWrite(PIN_LED, HIGH);
            // duration_ms applies here too if the caller wants a flash.
            if (duration > 0) {
                // Reuse the buzzer's auto-off scheduler — abusing for LED is
                // fine since rules don't currently flash both at once.
                // (TODO: separate ledOffAtMs when we have multi-LED severity.)
            }
            handled = true;
        }
    }

    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    httpd_resp_sendstr(req,
        handled ? "{\"ok\":true}"
                : "{\"ok\":false,\"error\":\"unknown device/state\"}");
    return ESP_OK;
}

// ============================================================================
// HTTP / handler — status JSON
// ============================================================================
static esp_err_t status_handler(httpd_req_t *req) {
    char resp[256];
    snprintf(resp, sizeof(resp),
        "{\"device\":\"%s\",\"ip\":\"%s\",\"uptime\":%lu,\"rssi\":%d,"
        "\"seq\":%lu,\"pan\":%.0f,\"tilt\":%.0f,\"phase\":1}",
        DEVICE_ID, deviceIp.c_str(), millis() / 1000, WiFi.RSSI(),
        seq, panAngle, tiltAngle);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    httpd_resp_sendstr(req, resp);
    return ESP_OK;
}

// ============================================================================
// /capture — one JPEG
// ============================================================================
static esp_err_t capture_handler(httpd_req_t *req) {
    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) {
        httpd_resp_send_500(req);
        return ESP_FAIL;
    }
    httpd_resp_set_type(req, "image/jpeg");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    esp_err_t res = httpd_resp_send(req, (const char*)fb->buf, fb->len);
    esp_camera_fb_return(fb);
    return res;
}

// ============================================================================
// :81 /stream — MJPEG
// ============================================================================
#define PART_BOUNDARY "123456789000000000000987654321"
static const char* _STREAM_CONTENT_TYPE =
    "multipart/x-mixed-replace;boundary=" PART_BOUNDARY;
static const char* _STREAM_BOUNDARY = "\r\n--" PART_BOUNDARY "\r\n";
static const char* _STREAM_PART =
    "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n";

static esp_err_t stream_handler(httpd_req_t *req) {
    camera_fb_t *fb = NULL;
    esp_err_t res = httpd_resp_set_type(req, _STREAM_CONTENT_TYPE);
    if (res != ESP_OK) return res;
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    char part_buf[64];
    while (true) {
        fb = esp_camera_fb_get();
        if (!fb) { res = ESP_FAIL; break; }
        size_t hlen = snprintf(part_buf, 64, _STREAM_PART, fb->len);
        res = httpd_resp_send_chunk(req, _STREAM_BOUNDARY, strlen(_STREAM_BOUNDARY));
        if (res == ESP_OK) res = httpd_resp_send_chunk(req, part_buf, hlen);
        if (res == ESP_OK) res = httpd_resp_send_chunk(req, (const char*)fb->buf, fb->len);
        esp_camera_fb_return(fb);
        if (res != ESP_OK) break;
    }
    return res;
}

// ============================================================================
// Camera + HTTP server init
// ============================================================================
bool cameraInit() {
    camera_config_t cfg = {};
    cfg.ledc_channel = LEDC_CHANNEL_0;
    cfg.ledc_timer   = LEDC_TIMER_0;
    cfg.pin_d0 = Y2_GPIO_NUM; cfg.pin_d1 = Y3_GPIO_NUM;
    cfg.pin_d2 = Y4_GPIO_NUM; cfg.pin_d3 = Y5_GPIO_NUM;
    cfg.pin_d4 = Y6_GPIO_NUM; cfg.pin_d5 = Y7_GPIO_NUM;
    cfg.pin_d6 = Y8_GPIO_NUM; cfg.pin_d7 = Y9_GPIO_NUM;
    cfg.pin_xclk     = XCLK_GPIO_NUM;
    cfg.pin_pclk     = PCLK_GPIO_NUM;
    cfg.pin_vsync    = VSYNC_GPIO_NUM;
    cfg.pin_href     = HREF_GPIO_NUM;
    cfg.pin_sccb_sda = SIOD_GPIO_NUM;
    cfg.pin_sccb_scl = SIOC_GPIO_NUM;
    cfg.pin_pwdn     = PWDN_GPIO_NUM;
    cfg.pin_reset    = RESET_GPIO_NUM;
    cfg.xclk_freq_hz = 20000000;
    cfg.pixel_format = PIXFORMAT_JPEG;
    cfg.frame_size   = FRAMESIZE_VGA;
    cfg.jpeg_quality = 12;
    cfg.fb_count     = 2;
    cfg.fb_location  = CAMERA_FB_IN_PSRAM;
    cfg.grab_mode    = CAMERA_GRAB_LATEST;
    return esp_camera_init(&cfg) == ESP_OK;
}

void startHttpServers() {
    httpd_config_t c80 = HTTPD_DEFAULT_CONFIG();
    c80.server_port = 80;
    c80.ctrl_port   = 32768;
    if (httpd_start(&cmd_httpd, &c80) == ESP_OK) {
        httpd_uri_t status_uri  = { "/",        HTTP_GET,  status_handler,  NULL };
        httpd_uri_t cmd_uri     = { "/cmd",     HTTP_POST, cmd_handler,     NULL };
        httpd_uri_t capture_uri = { "/capture", HTTP_GET,  capture_handler, NULL };
        httpd_register_uri_handler(cmd_httpd, &status_uri);
        httpd_register_uri_handler(cmd_httpd, &cmd_uri);
        httpd_register_uri_handler(cmd_httpd, &capture_uri);
        Serial.println("HTTP server :80 ready (/, /cmd, /capture)");
    }
    httpd_config_t c81 = HTTPD_DEFAULT_CONFIG();
    c81.server_port = 81;
    c81.ctrl_port   = 32769;
    if (httpd_start(&stream_httpd, &c81) == ESP_OK) {
        httpd_uri_t stream_uri = { "/stream", HTTP_GET, stream_handler, NULL };
        httpd_register_uri_handler(stream_httpd, &stream_uri);
        Serial.println("HTTP server :81 ready (/stream)");
    }
}

// ============================================================================
// WiFi
// ============================================================================
void wifiConnect() {
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    Serial.printf("Connecting to WiFi '%s'", WIFI_SSID);
    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 60) {
        delay(500);
        Serial.print(".");
        attempts++;
    }
    Serial.println();
    if (WiFi.status() == WL_CONNECTED) {
        deviceIp = WiFi.localIP().toString();
        Serial.printf("Connected. IP=%s RSSI=%d\n", deviceIp.c_str(), WiFi.RSSI());
    } else {
        Serial.println("WiFi connect failed — will retry from loop()");
    }
}

// ============================================================================
// setup / loop
// ============================================================================
void setup() {
    Serial.begin(115200);
    delay(500);
    Serial.println("\n=== demo2 ESP32-S3-CAM sensor node (Phase 1) ===");

    dht.begin();
    Serial.println("DHT11 driver attached (GPIO 2)");

    ledcAttach(SERVO_PAN_PIN,  SERVO_FREQ, SERVO_RESOLUTION);
    ledcAttach(SERVO_TILT_PIN, SERVO_FREQ, SERVO_RESOLUTION);
    servoWrite(SERVO_PAN_PIN,  90.0f);
    servoWrite(SERVO_TILT_PIN, 90.0f);
    Serial.println("Servos centered (Pan=14, Tilt=3)");

    pinMode(PIN_PIR, INPUT);
    pinMode(PIN_HCSR_TRIG, OUTPUT);
    pinMode(PIN_HCSR_ECHO, INPUT);
    digitalWrite(PIN_HCSR_TRIG, LOW);
    pinMode(PIN_BUZZER, OUTPUT);
    digitalWrite(PIN_BUZZER, LOW);
    pinMode(PIN_LED, OUTPUT);
    digitalWrite(PIN_LED, LOW);
    Serial.println("Phase 2: PIR=21, HC-SR04 trig=42 echo=41, BUZZER=45, LED=1");

    oledInit();
    micInit();

    if (!cameraInit()) {
        Serial.println("WARN: camera init failed — sensors still work");
    } else {
        Serial.println("Camera initialized (OV2640 VGA)");
    }

    wifiConnect();

    if (WiFi.status() == WL_CONNECTED) {
        configTime(0, 0, "pool.ntp.org", "time.google.com");
        Serial.println("NTP sync requested");
        startHttpServers();
        Serial.printf("Stream:  http://%s:81/stream\n", deviceIp.c_str());
        Serial.printf("Capture: http://%s/capture\n",   deviceIp.c_str());
    }

    Serial.println("Setup complete.\n");
}

void loop() {
    unsigned long now = millis();

    // 1Hz sample + POST + OLED refresh
    if (now - lastSampleMs >= SAMPLE_INTERVAL_MS) {
        lastSampleMs = now;
        if (WiFi.status() == WL_CONNECTED) {
            postSensorFrame();
        }
        oledRender();
    }

    // Buzzer auto-off (rule actuators usually pass duration_ms=1500)
    if (buzzerOffAtMs != 0 && now >= buzzerOffAtMs) {
        digitalWrite(PIN_BUZZER, LOW);
        buzzerOffAtMs = 0;
    }

    // WiFi reconnect (5s polling)
    if (now - lastWifiCheck > 5000) {
        lastWifiCheck = now;
        if (WiFi.status() != WL_CONNECTED) {
            Serial.println("WiFi lost — reconnecting...");
            wifiConnect();
        }
    }
}
