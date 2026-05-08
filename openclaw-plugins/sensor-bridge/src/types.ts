/** Sensor frame ingested from the Python bridge at 1 Hz. */
export type SensorFrame = {
  ts: string;
  seq: number;
  temp_c: number;
  humidity: number;
  pir: 0 | 1;
  lux_raw: number;
  distance_cm: number;
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
    typeof v.distance_cm === "number"
  );
}
