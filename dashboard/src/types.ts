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
