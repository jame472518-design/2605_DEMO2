import type { Alert, SensorFrame, Severity } from "./types.js";

type Predicate = (f: SensorFrame) => boolean;

type Rule = {
  id: string;
  severity: Severity;
  check(history: SensorFrame[]): boolean;
  trigger(history: SensorFrame[]): Record<string, unknown>;
  actuator?: { device: "buzzer" | "led"; state: string; duration_ms?: number };
};

/**
 * True iff `pred` holds for the newest frame AND every frame within the last
 * `windowMs` AND there's at least one history sample older than the window
 * (i.e. we actually have enough data to claim the condition has been sustained).
 */
function sustainedTrue(history: SensorFrame[], windowMs: number, pred: Predicate): boolean {
  if (history.length === 0) return false;
  const newest = history[history.length - 1]!;
  if (!pred(newest)) return false;
  const cutoff = Date.parse(newest.ts) - windowMs;
  let i = history.length - 1;
  while (i >= 0 && Date.parse(history[i]!.ts) >= cutoff) {
    if (!pred(history[i]!)) return false;
    i--;
  }
  return i >= 0;
}

const RULES: Rule[] = [
  {
    id: "heat_sustained",
    severity: "warn",
    check: (h) => sustainedTrue(h, 60_000, (f) => f.temp_c > 30),
    trigger: (h) => ({
      temp_c: h[h.length - 1]!.temp_c,
      threshold: 30,
      window_s: 60,
    }),
    actuator: { device: "buzzer", state: "on", duration_ms: 1500 },
  },
  {
    id: "night_intrusion",
    severity: "critical",
    check: (h) => {
      const f = h[h.length - 1];
      return !!f && f.pir === 1 && f.lux_raw < 50;
    },
    trigger: (h) => ({
      pir: h[h.length - 1]!.pir,
      lux_raw: h[h.length - 1]!.lux_raw,
      threshold_lux: 50,
    }),
    actuator: { device: "led", state: "red" },
  },
  {
    id: "object_too_close",
    severity: "info",
    check: (h) => sustainedTrue(h, 3_000, (f) => f.distance_cm < 15),
    trigger: (h) => ({
      distance_cm: h[h.length - 1]!.distance_cm,
      threshold: 15,
      window_s: 3,
    }),
  },
];

export class RuleEngine {
  private readonly history: SensorFrame[] = [];
  private readonly maxHistory: number;
  /** Per-rule edge state: true while rule is currently firing (suppresses re-fires). */
  private readonly active = new Map<string, boolean>();

  constructor(maxHistory = 120) {
    this.maxHistory = maxHistory;
  }

  ingest(frame: SensorFrame): Alert[] {
    this.history.push(frame);
    while (this.history.length > this.maxHistory) this.history.shift();
    return this.evaluate(frame);
  }

  private evaluate(frame: SensorFrame): Alert[] {
    const fired: Alert[] = [];
    for (const rule of RULES) {
      const passes = rule.check(this.history);
      const wasActive = this.active.get(rule.id) ?? false;
      if (passes && !wasActive) {
        this.active.set(rule.id, true);
        fired.push({
          id: `alert_${Date.parse(frame.ts) || Date.now()}_${rule.id}`,
          ts: frame.ts,
          rule: rule.id,
          severity: rule.severity,
          trigger: rule.trigger(this.history),
          explanation: null,
          suggested_action: null,
          actuator_fired: rule.actuator?.device ?? null,
        });
      } else if (!passes && wasActive) {
        this.active.set(rule.id, false);
      }
    }
    return fired;
  }

  /** Look up actuator config by rule id (for routing actuator commands). */
  getActuator(ruleId: string): Rule["actuator"] {
    return RULES.find((r) => r.id === ruleId)?.actuator;
  }

  size(): number {
    return this.history.length;
  }
}
