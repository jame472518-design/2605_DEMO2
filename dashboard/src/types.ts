/**
 * Current firmware reports temp_c / humidity / audio_rms / pir / distance_cm /
 * pan_angle / tilt_angle. lux_raw is kept optional for backward-compat; the
 * LDR was dropped from the BOM and the dashboard no longer displays it.
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
  /** Set when the alert's rule has auto_vision and vision-1 returned a desc. */
  scene_description?: string | null;
  scene_took_ms?: number | null;
};

/** SSE updates after the initial alert are partial — only `id` is required,
 *  plus whatever fields the enrichment step filled. Dashboard merges by id. */
export type AlertUpdate = Partial<Alert> & { id: string };
