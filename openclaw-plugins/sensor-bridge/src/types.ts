/**
 * Sensor frame ingested from the device (ESP32 over WiFi, or mock) at 1 Hz.
 *
 * Phase 1 (current build) reports: temp_c, humidity, audio_rms, pan_angle,
 * tilt_angle. Phase 2 will add pir, lux_raw, distance_cm once those sensors
 * are physically wired — those fields stay optional so the rules engine
 * predicates (`makePredicate` rejects non-numeric values) gracefully no-op
 * for rules referencing missing metrics, and Phase 2 enablement requires no
 * schema migration.
 */
export type SensorFrame = {
  ts: string;
  seq: number;
  temp_c: number;
  humidity: number;
  /** PIR motion detector (Phase 2). 1 = motion detected this sample, 0 = idle. */
  pir?: 0 | 1;
  /** LDR analog reading 0..4095 (Phase 2). Higher = brighter. */
  lux_raw?: number;
  /** HC-SR04 distance in cm (Phase 2). 999 = out of range / timeout. */
  distance_cm?: number;
  /** INMP441 mic RMS magnitude this 1Hz window (Phase 1). Roughly 0..15000. */
  audio_rms?: number;
  /** Camera pan-servo angle, degrees 0..180 (Phase 1). 90 = center. */
  pan_angle?: number;
  /** Camera tilt-servo angle, degrees 0..180 (Phase 1). 90 = center. */
  tilt_angle?: number;
  /**
   * The device's own IP. Set by the ESP32 firmware so the plugin can route
   * actuator commands and the dashboard's camera <img> back to the device.
   * Optional — the legacy USB-bridge path (mock_serial.py) does not set it.
   */
  device_ip?: string;
  /** Optional device identifier (e.g. "esp32-sensor-1"). Reserved for multi-device. */
  device_id?: string;
};

export type Severity = "info" | "warn" | "critical";

/**
 * Actuator command sent from the plugin back to the ESP32's HTTP /cmd endpoint.
 *
 * - buzzer/led: legacy Phase 2 actuators (still planned).
 * - servo (Phase 1): drive pan or tilt servo to an absolute angle 0..180.
 */
export type ActuatorCommand =
  | { device: "buzzer"; state: "on" | "off"; duration_ms?: number }
  | { device: "led"; state: "on" | "off" | "red" | "green" | "blue"; duration_ms?: number }
  | { device: "servo"; state: "pan" | "tilt"; angle: number };

export type Alert = {
  id: string;
  ts: string;
  rule: string;
  severity: Severity;
  trigger: Record<string, unknown>;
  explanation: string | null;
  suggested_action: string | null;
  actuator_fired: string | null;
};

export function isSensorFrame(value: unknown): value is SensorFrame {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const optNumber = (x: unknown) => x === undefined || typeof x === "number";
  return (
    typeof v.ts === "string" &&
    typeof v.seq === "number" &&
    typeof v.temp_c === "number" &&
    typeof v.humidity === "number" &&
    (v.pir === undefined || v.pir === 0 || v.pir === 1) &&
    optNumber(v.lux_raw) &&
    optNumber(v.distance_cm) &&
    optNumber(v.audio_rms) &&
    optNumber(v.pan_angle) &&
    optNumber(v.tilt_angle) &&
    (v.device_ip === undefined || typeof v.device_ip === "string") &&
    (v.device_id === undefined || typeof v.device_id === "string")
  );
}
