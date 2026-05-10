export type SensorFrame = {
  ts: string;
  seq: number;
  temp_c: number;
  humidity: number;
  pir: 0 | 1;
  lux_raw: number;
  distance_cm: number;
  device_ip?: string;
  device_id?: string;
};

export type DeviceInfo = {
  device_ip: string | null;
  device_id: string | null;
  last_seen: string | null;
  /** ESP32 MJPEG endpoint, derived as http://<device_ip>:81/stream when known. */
  camera_stream_url: string | null;
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
