import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { Alert, SensorFrame, Severity } from "./types.js";

type Predicate = (f: SensorFrame) => boolean;

type Rule = {
  id: string;
  severity: Severity;
  /** Returns true if the rule should fire at the newest frame (history.length-1). */
  check(history: SensorFrame[]): boolean;
  /** Diagnostic payload describing what tripped — written into Alert.trigger. */
  trigger(history: SensorFrame[]): Record<string, unknown>;
  actuator?: { device: "buzzer" | "led"; state: string; duration_ms?: number };
  /** If true, plugin should also grab a fresh ESP32 frame + vision-1 describe
   *  after this rule fires, broadcasting an alert update with scene_description. */
  autoVision?: boolean;
};

// ---- YAML schema ---------------------------------------------------------

type SimpleOp = ">" | "<" | ">=" | "<=" | "==" | "!=";
type SimpleCondition = {
  metric: keyof SensorFrame;
  op: SimpleOp;
  value: number;
  window_s?: number;
};
type CompositeCondition = { all?: SimpleCondition[]; any?: SimpleCondition[] };
type RuleConfigWhen = SimpleCondition | CompositeCondition;
type RuleConfig = {
  id: string;
  severity: Severity;
  when: RuleConfigWhen;
  actuator?: Rule["actuator"];
  auto_vision?: boolean;
};
type RulesFile = { rules: RuleConfig[] };

// ---- Helpers -------------------------------------------------------------

function compareOp(op: SimpleOp, a: number, b: number): boolean {
  switch (op) {
    case ">":
      return a > b;
    case "<":
      return a < b;
    case ">=":
      return a >= b;
    case "<=":
      return a <= b;
    case "==":
      return a === b;
    case "!=":
      return a !== b;
  }
}

function makePredicate(c: SimpleCondition): Predicate {
  return (f) => {
    const v = f[c.metric];
    return typeof v === "number" && compareOp(c.op, v, c.value);
  };
}

/**
 * True iff every frame from newest backwards through (and including) the
 * cutoff boundary `windowMs` ago satisfies `pred`. Walks the history once
 * from newest to oldest; the moment we encounter a sample at ts <= cutoff
 * AND it satisfies pred, we have full window coverage and return true.
 * Returns false if any visited sample fails pred, or if we run out of
 * history before reaching the cutoff (not enough data yet).
 */
function sustainedTrue(history: SensorFrame[], windowMs: number, pred: Predicate): boolean {
  if (history.length === 0) return false;
  const newest = history[history.length - 1]!;
  if (!pred(newest)) return false;
  const cutoff = Date.parse(newest.ts) - windowMs;
  for (let i = history.length - 1; i >= 0; i--) {
    const f = history[i]!;
    if (!pred(f)) return false;
    if (Date.parse(f.ts) <= cutoff) return true;
  }
  return false;
}

// ---- Compilation: RuleConfig → Rule -------------------------------------

function compileSimple(c: SimpleCondition): {
  check: (h: SensorFrame[]) => boolean;
  trigger: (h: SensorFrame[]) => Record<string, unknown>;
} {
  const pred = makePredicate(c);
  if (typeof c.window_s === "number" && c.window_s > 0) {
    const windowMs = c.window_s * 1000;
    return {
      check: (h) => sustainedTrue(h, windowMs, pred),
      trigger: (h) => ({
        [c.metric]: h[h.length - 1]?.[c.metric],
        threshold: c.value,
        window_s: c.window_s,
      }),
    };
  }
  return {
    check: (h) => {
      const newest = h[h.length - 1];
      return !!newest && pred(newest);
    },
    trigger: (h) => ({
      [c.metric]: h[h.length - 1]?.[c.metric],
      threshold: c.value,
    }),
  };
}

function compileComposite(c: CompositeCondition): {
  check: (h: SensorFrame[]) => boolean;
  trigger: (h: SensorFrame[]) => Record<string, unknown>;
} {
  const all = (c.all ?? []).map(compileSimple);
  const any = (c.any ?? []).map(compileSimple);
  return {
    check: (h) => {
      if (all.length > 0 && !all.every((p) => p.check(h))) return false;
      if (any.length > 0 && !any.some((p) => p.check(h))) return false;
      return all.length > 0 || any.length > 0;
    },
    trigger: (h) => {
      const out: Record<string, unknown> = {};
      for (const p of [...all, ...any]) Object.assign(out, p.trigger(h));
      return out;
    },
  };
}

function isComposite(when: RuleConfigWhen): when is CompositeCondition {
  return Object.prototype.hasOwnProperty.call(when, "all") ||
    Object.prototype.hasOwnProperty.call(when, "any");
}

function compileRule(cfg: RuleConfig): Rule {
  const compiled = isComposite(cfg.when)
    ? compileComposite(cfg.when)
    : compileSimple(cfg.when);
  return {
    id: cfg.id,
    severity: cfg.severity,
    actuator: cfg.actuator,
    check: compiled.check,
    trigger: compiled.trigger,
    autoVision: cfg.auto_vision ?? false,
  };
}

export function loadRules(yamlPath: string): Rule[] {
  const raw = readFileSync(yamlPath, "utf-8");
  const parsed = parseYaml(raw) as RulesFile;
  if (!parsed?.rules || !Array.isArray(parsed.rules)) {
    throw new Error(`rules.yaml: top-level "rules" array missing in ${yamlPath}`);
  }
  return parsed.rules.map(compileRule);
}

// ---- Engine --------------------------------------------------------------

export class RuleEngine {
  private readonly history: SensorFrame[] = [];
  private readonly maxHistory: number;
  private readonly active = new Map<string, boolean>();
  private readonly rules: Rule[];

  constructor(rules: Rule[] | string | number = DEFAULT_RULES, maxHistory = 120) {
    if (typeof rules === "number") {
      // Back-compat: legacy ctor signature `new RuleEngine(maxHistory)`.
      this.maxHistory = rules;
      this.rules = DEFAULT_RULES;
    } else if (typeof rules === "string") {
      this.maxHistory = maxHistory;
      this.rules = loadRules(rules);
    } else {
      this.maxHistory = maxHistory;
      this.rules = rules;
    }
  }

  ingest(frame: SensorFrame): Alert[] {
    this.history.push(frame);
    while (this.history.length > this.maxHistory) this.history.shift();
    return this.evaluate(frame);
  }

  private evaluate(frame: SensorFrame): Alert[] {
    const fired: Alert[] = [];
    for (const rule of this.rules) {
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

  getActuator(ruleId: string): Rule["actuator"] {
    return this.rules.find((r) => r.id === ruleId)?.actuator;
  }

  isAutoVision(ruleId: string): boolean {
    return this.rules.find((r) => r.id === ruleId)?.autoVision === true;
  }

  size(): number {
    return this.history.length;
  }
}

// ---- Default fallback (matches rules.yaml exactly) ----------------------
//
// Used when RuleEngine is constructed without specifying a YAML path. Tests
// rely on this; production loads from rules.yaml shipped alongside the plugin.

const DEFAULT_RULES: Rule[] = [
  compileRule({
    id: "heat_sustained",
    severity: "warn",
    when: { metric: "temp_c", op: ">", value: 32, window_s: 60 },
    actuator: { device: "buzzer", state: "on", duration_ms: 1500 },
  }),
  compileRule({
    id: "motion_detected",
    severity: "info",
    when: { metric: "pir", op: "==", value: 1 },
    actuator: { device: "led", state: "on" },
    auto_vision: true,
  }),
  compileRule({
    id: "object_too_close",
    severity: "info",
    when: { metric: "distance_cm", op: "<", value: 15, window_s: 3 },
  }),
  compileRule({
    id: "noise_event",
    severity: "info",
    when: { metric: "audio_rms", op: ">", value: 50000, window_s: 1 },
    auto_vision: true,
  }),
];
