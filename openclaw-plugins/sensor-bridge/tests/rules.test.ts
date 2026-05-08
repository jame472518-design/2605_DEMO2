import { describe, expect, it } from "vitest";
import { RuleEngine } from "../src/rules.js";
import type { SensorFrame } from "../src/types.js";

const T0 = Date.parse("2026-05-08T00:00:00.000Z");

function frame(offsetSeconds: number, overrides: Partial<SensorFrame> = {}): SensorFrame {
  return {
    ts: new Date(T0 + offsetSeconds * 1000).toISOString(),
    seq: offsetSeconds,
    temp_c: 24,
    humidity: 60,
    pir: 0,
    lux_raw: 400,
    distance_cm: 80,
    ...overrides,
  };
}

describe("RuleEngine", () => {
  it("emits no alerts on a single calm frame", () => {
    const engine = new RuleEngine();
    expect(engine.ingest(frame(0))).toEqual([]);
  });

  describe("heat_sustained", () => {
    it("does NOT fire before a full 60s of >30°C history", () => {
      const engine = new RuleEngine();
      // Feed 60 hot frames covering [0..59s] = 59 seconds of evidence.
      for (let i = 0; i < 60; i++) {
        const fired = engine.ingest(frame(i, { temp_c: 31 }));
        expect(fired.find((a) => a.rule === "heat_sustained")).toBeUndefined();
      }
    });

    it("fires exactly once when 60s window is fully covered", () => {
      const engine = new RuleEngine();
      let fired: ReturnType<RuleEngine["ingest"]> = [];
      // Feed 61 frames at [0..60s] = 60 seconds of evidence — boundary case.
      for (let i = 0; i <= 60; i++) {
        fired = engine.ingest(frame(i, { temp_c: 31 }));
      }
      const heat = fired.find((a) => a.rule === "heat_sustained");
      expect(heat).toBeDefined();
      expect(heat?.severity).toBe("warn");
      expect(heat?.actuator_fired).toBe("buzzer");
    });

    it("dedups while temp stays high", () => {
      const engine = new RuleEngine();
      let fireCount = 0;
      for (let i = 0; i <= 90; i++) {
        const fired = engine.ingest(frame(i, { temp_c: 31 }));
        fireCount += fired.filter((a) => a.rule === "heat_sustained").length;
      }
      expect(fireCount).toBe(1);
    });

    it("re-arms after temp drops then re-rises", () => {
      const engine = new RuleEngine();
      let fireCount = 0;
      // Hot for 65s → fire once
      for (let i = 0; i <= 65; i++) {
        fireCount += engine.ingest(frame(i, { temp_c: 31 }))
          .filter((a) => a.rule === "heat_sustained").length;
      }
      expect(fireCount).toBe(1);
      // Cool down
      for (let i = 66; i <= 70; i++) {
        engine.ingest(frame(i, { temp_c: 25 }));
      }
      // Hot again for 65s → fire again
      for (let i = 71; i <= 136; i++) {
        fireCount += engine.ingest(frame(i, { temp_c: 31 }))
          .filter((a) => a.rule === "heat_sustained").length;
      }
      expect(fireCount).toBe(2);
    });
  });

  describe("night_intrusion", () => {
    it("does NOT fire when only PIR is high (lux still bright)", () => {
      const engine = new RuleEngine();
      const fired = engine.ingest(frame(0, { pir: 1, lux_raw: 400 }));
      expect(fired.find((a) => a.rule === "night_intrusion")).toBeUndefined();
    });

    it("does NOT fire when only lux is dark (PIR idle)", () => {
      const engine = new RuleEngine();
      const fired = engine.ingest(frame(0, { pir: 0, lux_raw: 20 }));
      expect(fired.find((a) => a.rule === "night_intrusion")).toBeUndefined();
    });

    it("fires immediately when both conditions hold", () => {
      const engine = new RuleEngine();
      const fired = engine.ingest(frame(0, { pir: 1, lux_raw: 20 }));
      const intrusion = fired.find((a) => a.rule === "night_intrusion");
      expect(intrusion).toBeDefined();
      expect(intrusion?.severity).toBe("critical");
      expect(intrusion?.actuator_fired).toBe("led");
    });

    it("dedups while still triggered", () => {
      const engine = new RuleEngine();
      let count = 0;
      for (let i = 0; i < 5; i++) {
        count += engine.ingest(frame(i, { pir: 1, lux_raw: 20 }))
          .filter((a) => a.rule === "night_intrusion").length;
      }
      expect(count).toBe(1);
    });
  });

  describe("object_too_close", () => {
    it("does NOT fire on a single close reading", () => {
      const engine = new RuleEngine();
      const fired = engine.ingest(frame(0, { distance_cm: 10 }));
      expect(fired.find((a) => a.rule === "object_too_close")).toBeUndefined();
    });

    it("fires when distance < 15cm sustains for 3s", () => {
      const engine = new RuleEngine();
      let fired: ReturnType<RuleEngine["ingest"]> = [];
      for (let i = 0; i <= 3; i++) {
        fired = engine.ingest(frame(i, { distance_cm: 10 }));
      }
      const close = fired.find((a) => a.rule === "object_too_close");
      expect(close).toBeDefined();
      expect(close?.severity).toBe("info");
      expect(close?.actuator_fired).toBeNull();
    });
  });

  it("ring buffer trims at maxHistory", () => {
    const engine = new RuleEngine(10);
    for (let i = 0; i < 50; i++) engine.ingest(frame(i));
    expect(engine.size()).toBe(10);
  });
});
