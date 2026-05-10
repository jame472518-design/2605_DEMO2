/** Sensor frame ingested from the device (ESP32 over WiFi, or mock) at 1 Hz. */
export type SensorFrame = {
  ts: string;
  seq: number;
  temp_c: number;
  humidity: number;
  pir: 0 | 1;
  lux_raw: number;
  distance_cm: number;
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

export type ActuatorCommand = {
  device: "buzzer" | "led";
  state: "on" | "off" | "red" | "green" | "blue";
  duration_ms?: number;
};

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
  return (
    typeof v.ts === "string" &&
    typeof v.seq === "number" &&
    typeof v.temp_c === "number" &&
    typeof v.humidity === "number" &&
    (v.pir === 0 || v.pir === 1) &&
    typeof v.lux_raw === "number" &&
    typeof v.distance_cm === "number" &&
    (v.device_ip === undefined || typeof v.device_ip === "string") &&
    (v.device_id === undefined || typeof v.device_id === "string")
  );
}
