// Monte Carlo cross-check (raid-calc.md §3.8): validates the SOLVER, not the model.
// Gillespie discrete-event simulation over the SAME machine representation the analytic
// solver consumes — identical transitions, identical rate semantics — so agreement within
// MC noise verifies the ODE integration and accounting, nothing else.
//
// URE note: rate-based loss events (machine.lossRate1/2) are simulated; their per-event
// cost is read from machine.eventCost1/eventCost2 when exposed. The current machine
// builders do not expose them yet (they are local constants in buildErasureLeaf), so URE
// events are sampled but contribute 0 to cumulative loss — the analytic-vs-MC comparison
// therefore excludes the URE contribution until eventCost1/2 land on the machine. The MC
// code picks it up automatically once exposed (forward-compatible).

import { validate, TB } from "./config.js";
import { buildPoolMachine } from "./machine.js";
import { timePoints } from "./evaluate.js";

export { ConfigError } from "./config.js";
export { BuildError } from "./machine.js";

// Deterministic PRNG (mulberry32): fixed seed => identical curves.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildAdjacency(machine) {
  const adj = Array.from({ length: machine.nStates }, () => []);
  for (const t of machine.transitions) {
    if (!(t.rate > 0)) continue;
    adj[t.from].push([t.to, t.rate]);
  }
  return adj;
}

// One Gillespie run over `horizonH` hours. Returns end-of-run cumulative losses.
// (simulate() runs the grid-recording variant inline for aggregation.)
export function simulateOnce(machine, horizonH, rng) {
  const adj = buildAdjacency(machine);
  const n = machine.nStates;
  let s = machine.initialState ?? 0;
  let t = 0;
  let c1 = machine.lostFraction[s];
  let c2 = (machine.lostFraction2 ?? machine.lostFraction)[s];
  let any = false;
  const cost1 = machine.eventCost1 ?? 0;
  while (t <= horizonH) {
    let total = (machine.lossRate1?.[s] || 0) + (machine.lossRate2?.[s] || 0);
    const list = adj[s];
    for (let i = 0; i < list.length; i++) total += list[i][1];
    if (!(total > 0)) break; // absorbing
    t += -Math.log(1 - rng()) / total;
    if (t > horizonH) break;
    const x = rng() * total;
    let acc = 0;
    const r1 = machine.lossRate1?.[s] || 0;
    acc += r1;
    if (x < acc) {
      // URE rate event: adds its per-event cost to the rigorous loss
      const before = c1;
      c1 += cost1;
      if (c1 > before) any = true;
      continue;
    }
    acc += machine.lossRate2?.[s] || 0;
    if (x < acc) {
      c2 += machine.eventCost2 ?? 0; // partial-mode-only loss increment
      continue;
    }
    for (let i = 0; i < list.length; i++) {
      acc += list[i][1];
      if (x < acc) {
        const to = list[i][0];
        const d1 = machine.lostFraction[to] - machine.lostFraction[s];
        const d2 = (machine.lostFraction2 ?? machine.lostFraction)[to] -
          (machine.lostFraction2 ?? machine.lostFraction)[s];
        c1 += d1;
        c2 += d2;
        if (d1 > 0) any = true;
        s = to;
        break;
      }
    }
  }
  void n;
  return { cum1: c1, cum2: c2, anyLoss: any };
}

// Aggregate simulation over `runs` seeded runs; mirrors evaluate()'s output shape.
// times: increasing hours, times[0] === 0 (pass timePoints() output or a custom grid).
export function simulate(config, { runs = 20000, points = 101, seed = 0x9e3779b9, stateBudget } = {}) {
  const { usableBytes } = validate(config);
  const usedBytes = config.workload.storeTB * TB;

  let root = config.tree;
  if (root.node === "kind") {
    root = { node: "pool", strategy: "concat", lambdaCC: 0, members: [root] };
  }
  const machine = buildPoolMachine(
    root,
    {
      kinds: config.kinds,
      global: config.global,
      workload: config.workload,
      usedBytes,
    },
    stateBudget,
  );
  const times = timePoints(config.workload.horizonY, points);
  const horizonH = times[times.length - 1];
  const adj = buildAdjacency(machine);
  const lf1 = machine.lostFraction;
  const lf2 = machine.lostFraction2 ?? machine.lostFraction;
  const cost1 = machine.eventCost1 ?? 0;
  const cost2 = machine.eventCost2 ?? 0;
  const n = machine.nStates;
  const rng = mulberry32(seed);

  const sum1 = new Float64Array(times.length);
  const sum2 = new Float64Array(times.length);
  const anyCount = new Float64Array(times.length);
  // per-run grid values (reused buffers, no inner-loop allocation)
  const g1 = new Float64Array(times.length);
  const g2 = new Float64Array(times.length);
  const gAny = new Uint8Array(times.length);

  for (let run = 0; run < runs; run++) {
    let s = machine.initialState ?? 0;
    let t = 0;
    let c1 = lf1[s];
    let c2 = lf2[s];
    let any = false;
    let gi = 1; // times[0] = 0 is recorded below via initial fill
    g1[0] = c1;
    g2[0] = c2;
    gAny[0] = 0;
    while (t <= horizonH) {
      let total = (machine.lossRate1?.[s] || 0) + (machine.lossRate2?.[s] || 0);
      const list = adj[s];
      for (let i = 0; i < list.length; i++) total += list[i][1];
      if (!(total > 0)) break; // absorbing: remaining grid points keep current values
      t += -Math.log(1 - rng()) / total;
      if (t > horizonH) break;
      // grid points strictly before the event keep the pre-event (piecewise-constant) values
      while (gi < times.length && times[gi] < t) {
        g1[gi] = c1;
        g2[gi] = c2;
        gAny[gi] = any ? 1 : 0;
        gi++;
      }
      const x = rng() * total;
      let acc = 0;
      const r1 = machine.lossRate1?.[s] || 0;
      acc += r1;
      if (x < acc) {
        const before = c1;
        c1 += cost1;
        if (c1 > before) any = true;
        continue;
      }
      acc += machine.lossRate2?.[s] || 0;
      if (x < acc) {
        c2 += cost2;
        continue;
      }
      for (let i = 0; i < list.length; i++) {
        acc += list[i][1];
        if (x < acc) {
          const to = list[i][0];
          const d1 = lf1[to] - lf1[s];
          const d2 = lf2[to] - lf2[s];
          c1 += d1;
          c2 += d2;
          if (d1 > 0) any = true;
          s = to;
          break;
        }
      }
    }
    for (; gi < times.length; gi++) {
      g1[gi] = c1;
      g2[gi] = c2;
      gAny[gi] = any ? 1 : 0;
    }
    for (let i = 0; i < times.length; i++) {
      sum1[i] += g1[i];
      sum2[i] += g2[i];
      anyCount[i] += gAny[i];
    }
  }

  const mode1 = Array.from(sum1, (v) => v / runs);
  const mode2 = Array.from(sum2, (v) => v / runs);
  const anyLossProb = Array.from(anyCount, (v) => v / runs);
  return {
    times,
    expectedLostFraction: mode1,
    expectedLostFractionPartial: mode2,
    expectedLostBytes: mode1.map((f) => f * usedBytes),
    expectedLostBytesPartial: mode2.map((f) => f * usedBytes),
    anyLossProb,
    runs,
    seed,
    usedBytes,
    usableBytes,
    stateCount: machine.nStates,
  };
}
