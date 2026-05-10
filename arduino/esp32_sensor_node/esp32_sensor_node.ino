/*
 * demo2 — ESP32-S3-CAM Sensor Node
 * Board: GOOUUU ESP32-S3-CAM-N16R8 (OV2640)
 *
 * Reads DHT11 + PIR + LDR + HC-SR04 every 1s, POSTs JSON to the demo2
 * sensor-bridge plugin over WiFi. Hosts an HTTP server on port 80 to
 * receive actuator commands (buzzer / LED) from the plugin, and on
 * port 81 to serve an MJPEG camera stream consumed by the dashboard's
 * CameraCard.
 *
 * No MQTT, no Jetson — direct HTTP into the demo2 plugin.
 *
 * Arduino IDE Settings:
 *   Board: "ESP32S3 Dev Module"
 *   USB CDC On Boot: "Disabled"  (free GPIO 19/20 for LED + spare)
 *   Flash Size: "16MB"
 *   PSRAM: "OPI PSRAM"
 *   Partition Scheme: "Huge APP (3MB No OTA/1MB SPIFFS)"
 *
 * Libraries:
 *   - DHT sensor library (Adafruit) — DHT11 read
 *   - Adafruit Unified Sensor (DHT dependency)
 *
 * Wiring: see docs/WIRING-ESP32.md
 *
 * Configuration: copy secrets.h.example to secrets.h and fill in WiFi creds,
 *                PC host, and the gateway token from .env.local.
 */

#include "secrets.h"

#include <WiFi.h>
#include <HTTPClient.h>
#include <DHT.h>
#include "esp_camera.h"
#include "esp_http_server.h"
#include "time.h"

// ============================================================================
// Pin map (ESP32-S3-CAM N16R8). Camera owns 4-18 (varied) — we use the rest.
// ============================================================================
#define PIN_LDR        1   // ADC1_CH0 — only ADC1 works reliably with WiFi on
#define PIN_DHT        21
#define PIN_PIR        41
#define PIN_HCSR_TRIG  42
#define PIN_HCSR_ECHO  45  // 5V echo MUST go through a voltage divider to 3.3V
#define PIN_BUZZER     46
#define PIN_LED        19  // single-color LED, 220Ω series resistor

// Camera pins (GOOUUU ESP32-S3-CAM, same as previous project)
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

// ============================================================================
// Globals
// ============================================================================
DHT dht(PIN_DHT, DHT11);

httpd_handle_t cmd_httpd    = NULL;
httpd_handle_t stream_httpd = NULL;

unsigned long lastSampleMs   = 0;
unsigned long buzzerOffAtMs  = 0;
unsigned long seq            = 0;
unsigned long lastWifiCheck  = 0;
const unsigned long SAMPLE_INTERVAL_MS = 1000;

String deviceIp;

// ============================================================================
// HC-SR04 distance (cm). Returns 999.0 on timeout / out of range.
// ============================================================================
float readDistanceCm() {
    digitalWrite(PIN_HCSR_TRIG, LOW);
    delayMicroseconds(2);
    digitalWrite(PIN_HCSR_TRIG, HIGH);
    delayMicroseconds(10);
    digitalWrite(PIN_HCSR_TRIG, LOW);
    unsigned long duration = pulseIn(PIN_HCSR_ECHO, HIGH, 30000UL); // 30ms ≈ 5m
    if (duration == 0) return 999.0;
    return (float)duration * 0.0343f / 2.0f;
}

// ============================================================================
// ISO 8601 UTC timestamp from NTP-synced clock. Falls back to "1970-..." if
// NTP isn't ready yet — the plugin still ingests but rule engine windowed
// conditions won't fire correctly until time is synced (usually within ~3s).
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
// POST a sensor frame to the plugin. Best-effort; logs on failure but never
// blocks more than a few seconds.
// ============================================================================
bool postSensorFrame() {
    float t = dht.readTemperature();
    float h = dht.readHumidity();
    if (isnan(t)) t = -127.0;
    if (isnan(h)) h = -1.0;
    int pir = digitalRead(PIN_PIR) == HIGH ? 1 : 0;
    int luxRaw = analogRead(PIN_LDR);                  // 0..4095 on ESP32-S3
    float dist = readDistanceCm();
    seq++;

    char ts[32];
    formatNowIso(ts, sizeof(ts));

    char body[400];
    snprintf(body, sizeof(body),
        "{\"ts\":\"%s\",\"seq\":%lu,\"temp_c\":%.2f,\"humidity\":%.2f,"
        "\"pir\":%d,\"lux_raw\":%d,\"distance_cm\":%.1f,"
        "\"device_ip\":\"%s\",\"device_id\":\"%s\"}",
        ts, seq, t, h, pir, luxRaw, dist,
        deviceIp.c_str(), DEVICE_ID);

    HTTPClient http;
    String url = String("http://") + PC_HOST + ":18790/api/sensor/ingest";
    http.begin(url);
    http.setTimeout(2000);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("Authorization", String("Bearer ") + GATEWAY_TOKEN);
    int code = http.POST((uint8_t*)body, strlen(body));
    bool ok = (code == 200);
    if (!ok) {
        Serial.printf("ingest POST failed code=%d url=%s\n", code, url.c_str());
    }
    http.end();
    return ok;
}

// ============================================================================
// Actuator drive
// ============================================================================
void buzzerOn(unsigned long durationMs) {
    digitalWrite(PIN_BUZZER, HIGH);
    if (durationMs > 0) {
        buzzerOffAtMs = millis() + durationMs;
    } else {
        buzzerOffAtMs = 0; // stay on until explicit OFF
    }
}
void buzzerOff() {
    digitalWrite(PIN_BUZZER, LOW);
    buzzerOffAtMs = 0;
}
void ledSet(bool on) {
    digitalWrite(PIN_LED, on ? HIGH : LOW);
}

// ============================================================================
// HTTP /cmd handler. Body = JSON
//   { "device": "buzzer"|"led", "state": "on"|"off"|"red"|"green"|..., "duration_ms"? }
// ============================================================================
static esp_err_t cmd_handler(httpd_req_t *req) {
    char buf[200];
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

    // Tiny parser — avoid ArduinoJson dep. Looks for "device" and "state".
    auto extract = [&](const String& key) -> String {
        int i = body.indexOf("\"" + key + "\"");
        if (i < 0) return "";
        int q1 = body.indexOf('"', body.indexOf(':', i) + 1);
        if (q1 < 0) return "";
        int q2 = body.indexOf('"', q1 + 1);
        if (q2 < 0) return "";
        return body.substring(q1 + 1, q2);
    };
    auto extractInt = [&](const String& key) -> long {
        int i = body.indexOf("\"" + key + "\"");
        if (i < 0) return 0;
        int colon = body.indexOf(':', i);
        if (colon < 0) return 0;
        return atol(body.c_str() + colon + 1);
    };

    String device = extract("device");
    String state  = extract("state");
    long duration = extractInt("duration_ms");

    Serial.printf("/cmd device=%s state=%s duration=%ld\n",
        device.c_str(), state.c_str(), duration);

    bool handled = false;
    if (device == "buzzer") {
        if (state == "on") { buzzerOn(duration > 0 ? duration : 1500); handled = true; }
        else if (state == "off") { buzzerOff(); handled = true; }
    } else if (device == "led") {
        if (state == "off") { ledSet(false); handled = true; }
        else if (state == "on" || state == "red" || state == "green" || state == "blue") {
            ledSet(true);
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
// HTTP / handler — minimal status JSON
// ============================================================================
static esp_err_t status_handler(httpd_req_t *req) {
    char resp[200];
    snprintf(resp, sizeof(resp),
        "{\"device\":\"%s\",\"ip\":\"%s\",\"uptime\":%lu,\"rssi\":%d,\"seq\":%lu}",
        DEVICE_ID, deviceIp.c_str(), millis() / 1000, WiFi.RSSI(), seq);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    httpd_resp_sendstr(req, resp);
    return ESP_OK;
}

// ============================================================================
// HTTP /capture handler — single JPEG
// ============================================================================
static esp_err_t capture_handler(httpd_req_t *req) {
    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) {
        httpd_resp_send_500(req);
        return ESP_FAIL;
    }
    httpd_resp_set_type(req, "image/jpeg");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    esp_err_t res = httpd_resp_send(req, (const char *)fb->buf, fb->len);
    esp_camera_fb_return(fb);
    return res;
}

// ============================================================================
// HTTP :81/stream — MJPEG multipart
// ============================================================================
#define PART_BOUNDARY "123456789000000000000987654321"
static const char* _STREAM_CONTENT_TYPE =
    "multipart/x-mixed-replace;boundary=" PART_BOUNDARY;
static const char* _STREAM_BOUNDARY = "\r\n--" PART_BOUNDARY "\r\n";
static const char* _STREAM_PART = "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n";

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
bool camera_init() {
    camera_config_t cfg;
    cfg.ledc_channel = LEDC_CHANNEL_0;
    cfg.ledc_timer   = LEDC_TIMER_0;
    cfg.pin_d0       = Y2_GPIO_NUM;
    cfg.pin_d1       = Y3_GPIO_NUM;
    cfg.pin_d2       = Y4_GPIO_NUM;
    cfg.pin_d3       = Y5_GPIO_NUM;
    cfg.pin_d4       = Y6_GPIO_NUM;
    cfg.pin_d5       = Y7_GPIO_NUM;
    cfg.pin_d6       = Y8_GPIO_NUM;
    cfg.pin_d7       = Y9_GPIO_NUM;
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
    cfg.frame_size   = FRAMESIZE_VGA;     // 640x480 — good demo balance
    cfg.jpeg_quality = 12;
    cfg.fb_count     = 2;
    cfg.fb_location  = CAMERA_FB_IN_PSRAM;
    cfg.grab_mode    = CAMERA_GRAB_LATEST;
    return esp_camera_init(&cfg) == ESP_OK;
}

void start_http_servers() {
    // Port 80: /, /cmd (POST), /capture
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

    // Port 81: /stream (MJPEG)
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
void wifi_connect() {
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
        Serial.println("WiFi connect failed — will retry in loop()");
    }
}

// ============================================================================
// setup / loop
// ============================================================================
void setup() {
    Serial.begin(115200);
    delay(500);
    Serial.println("\n=== demo2 ESP32-S3-CAM sensor node ===");

    pinMode(PIN_PIR, INPUT);
    pinMode(PIN_HCSR_TRIG, OUTPUT);
    pinMode(PIN_HCSR_ECHO, INPUT);
    pinMode(PIN_BUZZER, OUTPUT);
    pinMode(PIN_LED, OUTPUT);
    digitalWrite(PIN_BUZZER, LOW);
    digitalWrite(PIN_LED, LOW);

    dht.begin();

    if (!camera_init()) {
        Serial.println("WARN: camera init failed — sensors will still work");
    } else {
        Serial.println("Camera initialized");
    }

    wifi_connect();

    if (WiFi.status() == WL_CONNECTED) {
        // NTP for ISO timestamps
        configTime(0, 0, "pool.ntp.org", "time.google.com");
        Serial.println("NTP sync requested");
        start_http_servers();
        Serial.printf("Stream:  http://%s:81/stream\n", deviceIp.c_str());
        Serial.printf("Capture: http://%s/capture\n", deviceIp.c_str());
    }

    Serial.println("Setup complete.");
}

void loop() {
    unsigned long now = millis();

    // 1Hz sensor sample + POST
    if (now - lastSampleMs >= SAMPLE_INTERVAL_MS) {
        lastSampleMs = now;
        if (WiFi.status() == WL_CONNECTED) {
            postSensorFrame();
        }
    }

    // Buzzer auto-off
    if (buzzerOffAtMs != 0 && now >= buzzerOffAtMs) {
        digitalWrite(PIN_BUZZER, LOW);
        buzzerOffAtMs = 0;
    }

    // WiFi reconnect
    if (now - lastWifiCheck > 5000) {
        lastWifiCheck = now;
        if (WiFi.status() != WL_CONNECTED) {
            Serial.println("WiFi lost — reconnecting...");
            wifi_connect();
        }
    }
}
