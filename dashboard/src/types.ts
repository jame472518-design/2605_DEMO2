/**
 * Phase 1 firmware reports temp_c / humidity / audio_rms / pan_angle /
 * tilt_angle. Phase 2 fields (pir, lux_raw, distance_cm) are reported only
 * once that hardware is wired — until then, the dashboard renders them
 * as "—" rather than NaN/undefined.
 */
export type SensorFrame = {
  ts: string;
  seq: number;
  temp_c: number;
  humidity: number;
  pir?: 0 | 1;
  lux_raw?: number;
  distance_cm?: number;
  audio_rms?: number;
  pan_angle?: number;
  tilt_angle?: number;
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
