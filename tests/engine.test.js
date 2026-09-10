import { describe, it, expect } from "vitest";
import { buildPoolMachine } from "../src/core/machine.js";
import { expectedLossCurve, anyLossCurve } from "../src/core/ctmc.js";

const CTX = (over = {}) => ({
  kinds: { d: { capacityTB: 4, lambdaBase: 1e-5, lambdaRead: 0, lambdaWrite: 0, ure: 0, readBW: 1.12e8, writeBW: 1.12e8, count: 8, spares: 0 } },
  global: { tOpH: 0, tSwapH: 0, tProcH: 0, rebuildBw: 150e6, contention: true, ...over.global },
  workload: { readBps: 0, writeBps: 0, ...over.workload },
  usedBytes: 16e12,
  ...over.ctx,
});

const stripPool = (d, m, members = 1) => ({
  node: "pool", strategy: "strip", d, m, lambdaCC: 0,
  members: Array.from({ length: d + m }, () => ({ node: "kind", kind: "d", count: members })),
});

describe("solver vs closed forms", () => {
  it("single disk: P(any loss)(t) = 1 - exp(-lambda t) exactly", () => {
    const lambda = 1e-5;
    const machine = buildPoolMachine(
      { node: "pool", strategy: "concat", lambdaCC: 0, members: [{ node: "kind", kind: "d", count: 1 }] },
      CTX({ ctx: { usedBytes: 4e12 } }), 1e6,
    );
    const t = [0, 1e4, 5e4, 2e5];
    const got = anyLossCurve(machine, t);
    t.forEach((ti, i) => expect(got[i]).toBeCloseTo(1 - Math.exp(-lambda * ti), 6));
    const e = expectedLossCurve(machine, t);
    e.forEach((v, i) => expect(v).toBeCloseTo(1 - Math.exp(-lambda * t[i]), 6)); // used = 1 member = all used
  });

  it("RAID1 mirror: matches the analytic 2-state birth-death survival", () => {
    const lambda = 1e-5;
    const ctx = CTX({ ctx: { usedBytes: 4e12 } }); // rebuild 4TB at 1.12e8 B/s -> ~9.92h
    const machine = buildPoolMachine(stripPool(1, 1), ctx, 1e6);
    const tRebuild = 2e12 / (1.12e8 * 3600); // per-member used = 2TB (even split over 2 members)
    const mu = 1 / tRebuild;
    // analytic survival of {0 dead, 1 dead} chain: Q = [[-2l, 2l], [mu, -(l+mu)]]
    const tr = -(3 * lambda + mu), det = 2 * lambda * lambda;
    const disc = Math.sqrt(tr * tr - 4 * det);
    const r1 = (tr + disc) / 2, r2 = (tr - disc) / 2;
    const S = (t) => (r1 * Math.exp(r2 * t) - r2 * Math.exp(r1 * t)) / (r1 - r2);
    const times = [0, 1e3, 1e4, 5e4, 2e5];
    const got = anyLossCurve(machine, times);
    times.forEach((ti, i) => expect(got[i]).toBeCloseTo(1 - S(ti), 5));
  });

  it("RAID5 (strip 3+1): hazard matches first-order MTTDL within 2%", () => {
    const lambda = 1e-5, N = 4, MTTR = 4e12 / (1.12e8 * 3600); // ~9.92h
    const machine = buildPoolMachine(stripPool(3, 1), CTX(), 1e6);
    const MTTDL = 1 / (N * lambda * (N - 1) * lambda * MTTR); // first order
    const tStar = 0.05 * MTTDL;
    const P = anyLossCurve(machine, [0, tStar])[1];
    const hazardNumeric = -Math.log(1 - P) / tStar;
    expect(hazardNumeric / (1 / MTTDL)).toBeGreaterThan(0.98);
    expect(hazardNumeric / (1 / MTTDL)).toBeLessThan(1.02);
  });

  it("staged repair (T_op>0): first-order MTTDL uses the summed MTTR within 2%", { timeout: 120000 }, () => {
    const lambda = 1e-5, N = 4;
    const tRebuild = 4e12 / (1.12e8 * 3600);
    const ctx = CTX({ global: { tOpH: 2, tSwapH: 0, tProcH: 0, rebuildBw: 150e6, contention: true } });
    const machine = buildPoolMachine(stripPool(3, 1), ctx, 1e6);
    const MTTR = 2 + tRebuild;
    const MTTDL = 1 / (N * lambda * (N - 1) * lambda * MTTR);
    const tStar = 0.05 * MTTDL;
    const P = anyLossCurve(machine, [0, tStar])[1];
    const hazardNumeric = -Math.log(1 - P) / tStar;
    expect(hazardNumeric / (1 / MTTDL)).toBeGreaterThan(0.98);
    expect(hazardNumeric / (1 / MTTDL)).toBeLessThan(1.02);
  });
});

describe("composition", () => {
  it("concat of 2 disks at 50% usage: loss = P(disk 1 ever died); empty disk is free", () => {
    const lambda = 1e-5;
    // capacity 2x4TB, store 4TB -> all used bytes on disk 1
    const machine = buildPoolMachine(
      { node: "pool", strategy: "concat", lambdaCC: 0, members: [{ node: "kind", kind: "d", count: 2 }] },
      CTX({ ctx: { usedBytes: 4e12 } }), 1e6,
    );
    const times = [0, 1e4, 1e5];
    const got = expectedLossCurve(machine, times);
    times.forEach((ti, i) => expect(got[i]).toBeCloseTo(1 - Math.exp(-lambda * ti), 5));
  });

  it("strip(1,1) over two strip(3,1) pools: mirror-of-pools beats a single pool", { timeout: 120000 }, () => {
    const ctx = CTX();
    const child = { node: "pool", strategy: "strip", d: 3, m: 1, lambdaCC: 0, members: [{ node: "kind", kind: "d", count: 4 }] };
    const parent = { node: "pool", strategy: "strip", d: 1, m: 1, lambdaCC: 0, members: [child, child] };
    const machine = buildPoolMachine(parent, ctx, 1e6);
    // two identical 15-state children collapse to compositions of 2 into 15 parts = 120
    expect(machine.nStates).toBe(120);
    const times = [0, 1e5, 1e6];
    const parentP = anyLossCurve(machine, times);
    const childMachine = buildPoolMachine(child, ctx, 1e6);
    const childP = anyLossCurve(childMachine, times);
    times.forEach((t, i) => { if (t > 0) expect(parentP[i]).toBeLessThan(childP[i]); });
    // monotone
    for (let i = 1; i < parentP.length; i++) expect(parentP[i]).toBeGreaterThanOrEqual(parentP[i - 1] - 1e-12);
  });

  it("rejects a partially-loss child (concat) under a parent", () => {
    const child = { node: "pool", strategy: "concat", lambdaCC: 0, members: [{ node: "kind", kind: "d", count: 2 }] };
    const parent = { node: "pool", strategy: "strip", d: 1, m: 1, lambdaCC: 0, members: [child, child] };
    // usage spanning both concat members: 10TB over 2 children -> 5TB each -> child placement [4TB, 1TB]
    expect(() => buildPoolMachine(parent, CTX({ ctx: { usedBytes: 10e12 } }), 1e6)).toThrow(/ticket 06/);
  });

  it("enforces the state-space budget", () => {
    expect(() => buildPoolMachine(
      { node: "pool", strategy: "concat", lambdaCC: 0, members: [{ node: "kind", kind: "d", count: 8 }] },
      CTX({ ctx: { usedBytes: 4e12 } }), 100,
    )).toThrow(/budget/);
  });
});
