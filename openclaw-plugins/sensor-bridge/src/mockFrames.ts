/**
 * Synthetic SensorFrame generator used when no real ESP32 is present on the
 * LAN. Produces a believable, alert-triggering stream so the dashboard never
 * looks "dead" during a demo when the hardware is absent.
 *
 * The class is pure state — it does NOT broadcast or call into the rule
 * engine. The caller (sensor-bridge/index.ts) is responsible for feeding the
 * generated frame through the post-ingest pipeline (broadcast + rule engine
 * + judge + auto-vision). This separation lets us unit-test the generator
 * without the plugin runtime and keeps index.ts focused on wiring.
 *
 * Frames intentionally OMIT device_ip / device_id — the index.ts ingest
 * pipeline uses those fields to refresh `lastDevice`, and we must not let
 * synthetic traffic mask a real ESP32 coming online ("auto" mock mode would
 * otherwise self-perpetuate).
 *
 * seq starts at MOCK_SEQ_BASE (90000) — high enough that it's obvious in a
 * log dump whether a frame came from the mock generator or the real device
 * (which starts at seq=0 on boot).
 */

import type { SensorFrame } from "./types.js";

const MOCK_SEQ_BASE = 90_000;

type EventKind = "heat" | "motion" | "noise" | "distance";

type ScheduledEvent = {
  kind: EventKind;
  /** Absolute ms timestamp at which this event begins. */
  startAt: number;
  /** Mean re-schedule interval, ms. */
  meanIntervalMs: number;
  /** Half-width of uniform jitter applied to the next interval, ms. */
  jitterMs: number;
};

/** Random number in [-1, 1]. */
function unitNoise(): number {
  return Math.random() * 2 - 1;
}

/** Random integer in [-jitter, jitter]. */
function jitter(jitter: number): number {
  return Math.floor(unitNoise() * jitter);
}

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

export class MockFrameGenerator {
  private seq = MOCK_SEQ_BASE;

  // Random-walk baselines — each tick nudges these by a small noise term
  // toward their target setpoint, producing a slow drift instead of pure
  // independent noise frame-to-frame.
  private tempBase = 28.0;
  private humidityBase = 50.0;
  private distanceBase = 50.0;

  private readonly events: ScheduledEvent[];

  constructor(startTs: number = Date.now()) {
    // Stagger initial offsets so events do not all fire at second 0.
    // Tight booth cadence — aggregate ~1 popup per 12-15s so visitors never
    // wait long enough to think "is this thing working?"
    this.events = [
      { kind: "heat", startAt: startTs + 45_000, meanIntervalMs: 200_000, jitterMs: 25_000 },
      { kind: "motion", startAt: startTs + 10_000, meanIntervalMs: 30_000, jitterMs: 8_000 },
      { kind: "noise", startAt: startTs + 25_000, meanIntervalMs: 60_000, jitterMs: 12_000 },
      { kind: "distance", startAt: startTs + 35_000, meanIntervalMs: 80_000, jitterMs: 15_000 },
    ];
  }

  /**
   * Produce one synthetic frame for the given wall-clock `now` (ms).
   * Advances internal state. Safe to call once per second.
   */
  tick(now: number): SensorFrame {
    // --- Baseline random walks ----------------------------------------------
    // Drift each baseline toward its setpoint with light noise, then clamp.
    this.tempBase = clamp(
      this.tempBase + unitNoise() * 0.15 + (28.0 - this.tempBase) * 0.02,
      25,
      31,
    );
    this.humidityBase = clamp(
      this.humidityBase + unitNoise() * 1.0 + (50 - this.humidityBase) * 0.02,
      40,
      65,
    );
    this.distanceBase = clamp(
      this.distanceBase + unitNoise() * 1.5 + (50 - this.distanceBase) * 0.02,
      20,
      120,
    );

    // Per-tick jitter applied on top of the slow baselines.
    let temp_c = this.tempBase + unitNoise() * 0.3;
    let humidity = this.humidityBase + unitNoise() * 2;
    let distance_cm = this.distanceBase + unitNoise() * 3;
    // Noisy floor ~5000 ±1500. Use abs() so we never go negative.
    let audio_rms = Math.max(0, 5000 + unitNoise() * 1500);
    let pir: 0 | 1 = 0;

    // --- Scripted events ----------------------------------------------------
    // Each event has its own elapsed-time phase. Overlays replace (not add to)
    // the baseline value during the active phase so thresholds are predictable.
    for (const ev of this.events) {
      if (now < ev.startAt) continue;
      const elapsed = now - ev.startAt;

      switch (ev.kind) {
        case "heat": {
          // 10s ramp up (28→33), 70s hold ≥33, 10s ramp down. Total 90s.
          const HOLD_START_MS = 10_000;
          const HOLD_END_MS = 80_000;
          const TOTAL_MS = 90_000;
          if (elapsed < TOTAL_MS) {
            if (elapsed < HOLD_START_MS) {
              const f = elapsed / HOLD_START_MS;
              temp_c = 28 + f * 5; // 28 → 33
            } else if (elapsed < HOLD_END_MS) {
              temp_c = 33 + Math.random() * 0.5; // hold ≥33 with tiny noise
            } else {
              const f = (elapsed - HOLD_END_MS) / (TOTAL_MS - HOLD_END_MS);
              temp_c = 33 - f * 5; // 33 → 28
            }
          } else {
            this.rescheduleEvent(ev, now);
          }
          break;
        }
        case "motion": {
          // pir=1 held for 2s.
          const HOLD_MS = 2_000;
          if (elapsed < HOLD_MS) {
            pir = 1;
          } else {
            this.rescheduleEvent(ev, now);
          }
          break;
        }
        case "noise": {
          // audio_rms jumps to 60000 for 1.5s.
          const HOLD_MS = 1_500;
          if (elapsed < HOLD_MS) {
            audio_rms = 60_000 + Math.random() * 5_000;
          } else {
            this.rescheduleEvent(ev, now);
          }
          break;
        }
        case "distance": {
          // 4s ramp 50→8cm, 5s hold at 8cm. Total 9s.
          const RAMP_MS = 4_000;
          const HOLD_MS = 5_000;
          const TOTAL_MS = RAMP_MS + HOLD_MS;
          if (elapsed < TOTAL_MS) {
            if (elapsed < RAMP_MS) {
              const f = elapsed / RAMP_MS;
              distance_cm = 50 - f * 42; // 50 → 8
            } else {
              distance_cm = 8 + Math.random() * 1.5;
            }
          } else {
            this.rescheduleEvent(ev, now);
          }
          break;
        }
      }
    }

    this.seq += 1;
    const frame: SensorFrame = {
      ts: new Date(now).toISOString(),
      seq: this.seq,
      temp_c: Math.round(temp_c * 10) / 10,
      humidity: Math.round(humidity * 10) / 10,
      pir,
      distance_cm: Math.round(distance_cm * 10) / 10,
      audio_rms: Math.round(audio_rms),
    };
    return frame;
  }

  private rescheduleEvent(ev: ScheduledEvent, now: number): void {
    ev.startAt = now + ev.meanIntervalMs + jitter(ev.jitterMs);
  }
}
