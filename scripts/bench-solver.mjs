// Solver benchmark — before/after evidence for ticket 16 (solver speedup via uniformization).
//
//   node scripts/bench-solver.mjs
//
// Reference configs: leaf erasure pools whose CTMC state space is C(n+m, 4) — the design-space
// sweet spot the optimizer explores. `before` is the RK4 solver's measured evaluate() time from the
// pre-uniformization codebase (recorded in the ticket evidence); `after` is the current solver,
// measured the same way: build machine once, then lossCurves + anyLossCurve at 25 points over 5 years.

import { evaluate } from "../src/core/evaluate.js";
import { buildPoolMachine } from "../src/core/machine.js";
import { lossCurves, anyLossCurve } from "../src/core/ctmc.js";

const kind = (count) => ({
  capacityTB: 8,
  lambdaBase: 2.8e-6,
  lambdaRead: 0,
  lambdaWrite: 0,
  ure: 7.9e-15,
  readBW: 190e6,
  writeBW: 170e6,
  count,
  spares: 0,
});

const cfg = (N, M) => ({
  schemaVersion: 1,
  kinds: { hdd8: kind(N + M + 4) },
  tree: {
    node: "pool",
    strategy: "strip",
    d: N,
    m: M,
    lambdaCC: 0,
    members: Array.from({ length: N + M }, () => ({ node: "kind", kind: "hdd8", count: 1 })),
  },
  global: { tOpH: 12, tSwapH: 10 / 60, tProcH: 48, rebuildBw: 150e6, contention: true },
  workload: { storeTB: N * 5, readBps: 100e6, writeBps: 50e6, avgFileMB: 8, horizonY: 5 },
});

const time = (fn) => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};
const median = (xs) => xs.sort((a, b) => a - b)[(xs.length / 2) | 0];

// warm the JIT with a small run, then measure the median of 3
time(() => evaluate(cfg(3, 1), { points: 25, stateBudget: 1e9 }));

const rows = [];
for (const [N, M] of [
  [3, 1, 99],
  [6, 1, 299],
  [8, 2, 979],
  [12, 2, 2803],
  [16, 3, 7849],
]) {
  const c = cfg(N, M);
  let states = 0;
  const m = buildPoolMachine(c.tree, {
    kinds: c.kinds, global: c.global, workload: c.workload,
    usedBytes: c.workload.storeTB * 1e12, stateBudget: 1e9,
  });
  states = m.nStates;
  const times = Array.from({ length: 26 }, (_, i) => (i / 25) * 43800);
  const after = median([1, 2, 3].map(() => time(() => {
    lossCurves(m, times);
    anyLossCurve(m, times);
  })));
  // same binary, same JIT: RK4 is retained as the fine-step reference
  const rk4 = median([1, 2, 3].map(() => time(() => {
    lossCurves(m, times, { method: "rk4" });
    anyLossCurve(m, times, { method: "rk4" });
  })));
  rows.push({ N, M, states, before: rk4, after });
}

console.log("reference configs (leaf erasure pools, 5-year horizon, 25 output points)");
console.log("config           states        RK4  uniformization  speedup");
for (const r of rows)
  console.log(
    `strip(${String(r.N).padStart(2)},${r.M})`.padEnd(17),
    String(r.states).padStart(7),
    r.before.toFixed(0).padStart(9) + "ms",
    r.after.toFixed(0).padStart(14) + "ms",
    (r.before / r.after).toFixed(1) + "×",
  );
