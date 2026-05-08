"""
Mock serial source for demo2. Yields CSV lines identical in shape to what the
Arduino sketch produces ("seq,temp,humidity,pir,lux,distance"), at 1 Hz.

Generation profile:
  - temp_c     : sinusoid centered at 24.0 with amplitude 3.0, period 12 min,
                 plus small noise. With --force-heat, held at 32.0 for 70s
                 starting 5s after launch (triggers heat_sustained rule).
  - humidity   : 60.0 - 0.6*(temp-24) plus noise (loosely anti-correlated).
  - pir        : Poisson-ish: ~one trigger every 30s (15s on, then off again).
  - lux_raw    : Follows local wall-clock — day brightness 300-800, night 5-40,
                 smooth dawn/dusk transitions.
  - distance_cm: Random walk bounded to [10, 200].
"""

from __future__ import annotations

import math
import random
import sys
import time
from datetime import datetime
from typing import Iterator


class MockSerial:
    def __init__(self, force_heat: bool = False) -> None:
        self.t0 = time.monotonic()
        self.seq = 0
        self.force_heat = force_heat
        self.distance = 80.0
        # PIR state machine: occasionally goes 1 for ~3s then drops.
        self.pir_until = 0.0
        self.next_pir_attempt = 0.0
        # No serial.write target in mock — actuator commands just log to stderr.

    def __iter__(self) -> Iterator[str]:
        return self

    def __next__(self) -> str:
        self.seq += 1
        elapsed = time.monotonic() - self.t0
        time.sleep(max(0.0, self.seq - elapsed))  # 1 Hz pacing

        temp = self._temp(elapsed)
        humidity = max(20.0, min(95.0, 60.0 - 0.6 * (temp - 24.0) + random.gauss(0, 1.5)))
        pir = self._pir(elapsed)
        lux = self._lux()
        self.distance = max(10.0, min(200.0, self.distance + random.gauss(0, 4.0)))

        return f"{self.seq},{temp:.2f},{humidity:.2f},{pir},{int(lux)},{self.distance:.1f}"

    def _temp(self, elapsed: float) -> float:
        if self.force_heat and 5.0 <= elapsed <= 75.0:
            return 32.0 + random.gauss(0, 0.05)
        period_s = 720.0  # 12 min
        return 24.0 + 3.0 * math.sin(2 * math.pi * elapsed / period_s) + random.gauss(0, 0.1)

    def _pir(self, elapsed: float) -> int:
        now = elapsed
        if now < self.pir_until:
            return 1
        if now >= self.next_pir_attempt:
            # Mean inter-arrival ~30s
            self.next_pir_attempt = now + random.expovariate(1 / 30.0)
            self.pir_until = self.next_pir_attempt + random.uniform(2.0, 5.0)
            self.next_pir_attempt = self.pir_until + random.expovariate(1 / 30.0)
            return 1
        return 0

    def _lux(self) -> float:
        # 0.0 (midnight) -> 1.0 (noon) sinusoid
        h = datetime.now().hour + datetime.now().minute / 60.0
        # Daylight roughly 06:00-18:00; smooth via a clipped sine
        x = (h - 6.0) / 12.0  # 0 at sunrise, 1 at sunset
        if x < 0 or x > 1:
            base = random.uniform(5.0, 30.0)
        else:
            base = 50.0 + 750.0 * math.sin(math.pi * x)
        return base + random.gauss(0, base * 0.05)

    def write(self, _line: str) -> None:
        # Mock has no real serial — print to stderr so dev sees what plugin sent.
        print(f"[mock_serial] (would write to Arduino) {_line}", file=sys.stderr)
