// demo2 sensor station
// Reads DHT22 (temp+humidity), PIR motion, photoresistor (light), HC-SR04 (distance)
// every 1 second and prints CSV "seq,temp,humidity,pir,lux,distance" on Serial.
//
// Listens for control commands on Serial (one per line):
//   BUZZER ON [duration_ms]   - turn buzzer on; auto-off after duration_ms (default 1500)
//   BUZZER OFF                - turn buzzer off
//   LED RED|GREEN|BLUE|OFF    - set RGB LED state
//
// Pin map — see docs/WIRING.md. Adjust constants below if your wiring differs.

#include <DHT.h>

const uint8_t PIN_DHT       = 2;
const uint8_t PIN_PIR       = 3;
const uint8_t PIN_LDR       = A0;
const uint8_t PIN_HCSR_TRIG = 8;
const uint8_t PIN_HCSR_ECHO = 9;
const uint8_t PIN_BUZZER    = 11;
const uint8_t PIN_LED_R     = 5;
const uint8_t PIN_LED_G     = 6;
const uint8_t PIN_LED_B     = 7;

DHT dht(PIN_DHT, DHT22);

unsigned long lastSampleMs = 0;
const unsigned long SAMPLE_INTERVAL_MS = 1000;

unsigned long buzzerOffAtMs = 0;  // 0 = buzzer not currently timed-off
unsigned long seq = 0;

String inputLine;

void setup() {
  Serial.begin(9600);
  pinMode(PIN_PIR, INPUT);
  pinMode(PIN_HCSR_TRIG, OUTPUT);
  pinMode(PIN_HCSR_ECHO, INPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_LED_R, OUTPUT);
  pinMode(PIN_LED_G, OUTPUT);
  pinMode(PIN_LED_B, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);
  digitalWrite(PIN_LED_R, LOW);
  digitalWrite(PIN_LED_G, LOW);
  digitalWrite(PIN_LED_B, LOW);
  dht.begin();
  inputLine.reserve(64);
}

float readDistanceCm() {
  digitalWrite(PIN_HCSR_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_HCSR_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_HCSR_TRIG, LOW);
  unsigned long duration = pulseIn(PIN_HCSR_ECHO, HIGH, 30000UL);  // 30ms timeout (~5m)
  if (duration == 0) return 999.0;  // out of range
  return (float)duration * 0.0343f / 2.0f;
}

void emitFrame() {
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  if (isnan(t)) t = -127.0;
  if (isnan(h)) h = -1.0;
  int pir = digitalRead(PIN_PIR) == HIGH ? 1 : 0;
  int lux = analogRead(PIN_LDR);
  float dist = readDistanceCm();
  seq++;
  Serial.print(seq);
  Serial.print(',');
  Serial.print(t, 2);
  Serial.print(',');
  Serial.print(h, 2);
  Serial.print(',');
  Serial.print(pir);
  Serial.print(',');
  Serial.print(lux);
  Serial.print(',');
  Serial.println(dist, 1);
}

void setLed(uint8_t r, uint8_t g, uint8_t b) {
  digitalWrite(PIN_LED_R, r ? HIGH : LOW);
  digitalWrite(PIN_LED_G, g ? HIGH : LOW);
  digitalWrite(PIN_LED_B, b ? HIGH : LOW);
}

void handleCommand(const String& line) {
  if (line.startsWith("BUZZER ON")) {
    digitalWrite(PIN_BUZZER, HIGH);
    long duration = 1500;
    int sp = line.indexOf(' ', 7);  // after "BUZZER "
    if (sp > 0) {
      String tail = line.substring(sp + 1);
      tail.trim();
      long parsed = tail.toInt();
      if (parsed > 0) duration = parsed;
    }
    buzzerOffAtMs = millis() + duration;
  } else if (line == "BUZZER OFF") {
    digitalWrite(PIN_BUZZER, LOW);
    buzzerOffAtMs = 0;
  } else if (line == "LED RED") {
    setLed(1, 0, 0);
  } else if (line == "LED GREEN") {
    setLed(0, 1, 0);
  } else if (line == "LED BLUE") {
    setLed(0, 0, 1);
  } else if (line == "LED OFF") {
    setLed(0, 0, 0);
  }
}

void loop() {
  unsigned long now = millis();
  if (now - lastSampleMs >= SAMPLE_INTERVAL_MS) {
    lastSampleMs = now;
    emitFrame();
  }

  if (buzzerOffAtMs != 0 && now >= buzzerOffAtMs) {
    digitalWrite(PIN_BUZZER, LOW);
    buzzerOffAtMs = 0;
  }

  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (inputLine.length() > 0) {
        inputLine.toUpperCase();
        handleCommand(inputLine);
        inputLine = "";
      }
    } else if (inputLine.length() < 60) {
      inputLine += c;
    }
  }
}
