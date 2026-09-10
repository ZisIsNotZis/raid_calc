import { describe, it, expect } from "vitest";
import { buildPoolMachine } from "../src/core/machine.js";
import { lossCurves, anyLossCurve } from "../src/core/ctmc.js";
import { K_STATES } from "../src/core/machine.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const CTX = (over = {}) => ({
  kinds: {
    d: {
      capacityTB: 4,
      lambdaBase: 1e-5,
      lambdaRead: 0,
      lambdaWrite: 0,
      ure: 0,
      readBW: 1.12e8,
      writeBW: 1.12e8,
      count: 8,
      spares: 0,
    },
  },
  global: {
    tOpH: 0,
    tSwapH: 0,
    tProcH: 0,
    rebuildBw: 150e6,
    contention: true,
    ...over.global,
  },
  workload: { readBps: 0, writeBps: 0, avgFileMB: 8, ...over.workload },
  usedBytes: 16e12,
  ...over.ctx,
});

const stripPool = (d, m, members = 1) => ({
  node: "pool",
  strategy: "strip",
  d,
  m,
  lambdaCC: 0,
  members: Array.from({ length: d + m }, () => ({
    node: "kind",
    kind: "d",
    count: members,
  })),
});

describe("solver vs closed forms", () => {
  it("single disk: P(any loss)(t) = 1 - exp(-lambda t) exactly", () => {
    const lambda = 1e-5;
    const machine = buildPoolMachine(
      {
        node: "pool",
        strategy: "concat",
        lambdaCC: 0,
        members: [{ node: "kind", kind: "d", count: 1 }],
      },
      CTX({ ctx: { usedBytes: 4e12 } }),
      1e6,
    );
    const t = [0, 1e4, 5e4, 2e5];
    const got = anyLossCurve(machine, t);
    t.forEach((ti, i) =>
      expect(got[i]).toBeCloseTo(1 - Math.exp(-lambda * ti), 6),
    );
    const e = lossCurves(machine, t).mode1;
    e.forEach((v, i) => expect(v).toBeCloseTo(1 - Math.exp(-lambda * t[i]), 6)); // used = 1 member = all used
  });

  it("RAID1 mirror: matches the analytic 2-state birth-death survival", () => {
    const lambda = 1e-5;
    const ctx = CTX({ ctx: { usedBytes: 4e12 } }); // rebuild 4TB at 1.12e8 B/s -> ~9.92h
    const machine = buildPoolMachine(stripPool(1, 1), ctx, 1e6);
    const tRebuild = 2e12 / (1.12e8 * 3600); // per-member used = 2TB (even split over 2 members)
    const mu = 1 / tRebuild;
    // analytic survival of {0 dead, 1 dead} chain: Q = [[-2l, 2l], [mu, -(l+mu)]]
    const tr = -(3 * lambda + mu),
      det = 2 * lambda * lambda;
    const disc = Math.sqrt(tr * tr - 4 * det);
    const r1 = (tr + disc) / 2,
      r2 = (tr - disc) / 2;
    const S = (t) =>
      (r1 * Math.exp(r2 * t) - r2 * Math.exp(r1 * t)) / (r1 - r2);
    const times = [0, 1e3, 1e4, 5e4, 2e5];
    const got = anyLossCurve(machine, times);
    times.forEach((ti, i) => expect(got[i]).toBeCloseTo(1 - S(ti), 5));
  });

  it("RAID5 (strip 3+1): hazard matches first-order MTTDL within 2%", { timeout: 120000 }, () => {
    const lambda = 1e-5,
      N = 4,
      MTTR = 4e12 / (1.12e8 * 3600); // ~9.92h
    const machine = buildPoolMachine(stripPool(3, 1), CTX(), 1e6);
    const MTTDL = 1 / (N * lambda * (N - 1) * lambda * MTTR); // first order
    const tStar = 0.05 * MTTDL;
    const P = anyLossCurve(machine, [0, tStar])[1];
    const hazardNumeric = -Math.log(1 - P) / tStar;
    expect(hazardNumeric / (1 / MTTDL)).toBeGreaterThan(0.98);
    expect(hazardNumeric / (1 / MTTDL)).toBeLessThan(1.02);
  });

  it("staged repair (T_op>0): first-order MTTDL uses the summed MTTR within 2%", {
    timeout: 120000,
  }, () => {
    const lambda = 1e-5,
      N = 4;
    const tRebuild = 4e12 / (1.12e8 * 3600);
    const ctx = CTX({
      global: {
        tOpH: 2,
        tSwapH: 0,
        tProcH: 0,
        rebuildBw: 150e6,
        contention: true,
      },
    });
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
  it("concat of 2 disks at 50% usage: loss = P(disk 1 ever died); empty disk is free", { timeout: 60000 }, () => {
    const lambda = 1e-5;
    // capacity 2x4TB, store 4TB -> all used bytes on disk 1
    const machine = buildPoolMachine(
      {
        node: "pool",
        strategy: "concat",
        lambdaCC: 0,
        members: [{ node: "kind", kind: "d", count: 2 }],
      },
      CTX({ ctx: { usedBytes: 4e12 } }),
      1e6,
    );
    const times = [0, 1e4, 1e5];
    const got = lossCurves(machine, times).mode1;
    times.forEach((ti, i) =>
      expect(got[i]).toBeCloseTo(1 - Math.exp(-lambda * ti), 5),
    );
  });

  it("strip(1,1) over two strip(3,1) pools: exact independence identity + beats a single pool", {
    timeout: 120000,
  }, () => {
    const ctx = CTX();
    const child = {
      node: "pool",
      strategy: "strip",
      d: 3,
      m: 1,
      lambdaCC: 0,
      members: [{ node: "kind", kind: "d", count: 4 }],
    };
    const parent = {
      node: "pool",
      strategy: "strip",
      d: 1,
      m: 1,
      lambdaCC: 0,
      members: [child, child],
    };
    const machine = buildPoolMachine(parent, ctx, 1e6);
    // children have K_STATES=6 layouts: child states = C(4+5,5) = 126; identical children
    // collapse to compositions of 2 into 126 parts
    const childStates = 126;
    const expected = (childStates * (childStates + 1)) / 2;
    expect(machine.nStates).toBe(expected);
    const times = [0, 5e4, 1e5];
    const parentP = anyLossCurve(machine, times);
    // standalone reference: SAME usedBytes the parent distributes to each child (8TB)
    const childMachine = buildPoolMachine(
      child,
      { ...ctx, usedBytes: 8e12 },
      1e6,
    );
    const childP = anyLossCurve(childMachine, times);
    // composition exactness: independent identical children -> P(parent loss) = P(child lost)^2
    times.forEach((_t, i) =>
      expect(parentP[i]).toBeCloseTo(childP[i] ** 2, 10),
    );
    times.forEach((t, i) => {
      if (t > 0) expect(parentP[i]).toBeLessThan(childP[i]);
    });
    // monotone
    for (let i = 1; i < parentP.length; i++)
      expect(parentP[i]).toBeGreaterThanOrEqual(parentP[i - 1] - 1e-12);
  });

  it("expected lost fraction is monotone (both modes)", { timeout: 120000 }, () => {
    const ctx = CTX({ ctx: { usedBytes: 4e12 } });
    const machine = buildPoolMachine(stripPool(3, 1), ctx, 1e6);
    const { mode1, mode2 } = lossCurves(machine, [0, 1e4, 1e5]);
    for (const curve of [mode1, mode2]) {
      for (let i = 1; i < curve.length; i++)
        expect(curve[i]).toBeGreaterThanOrEqual(curve[i - 1] - 1e-12);
    }
  });

  it("split(2,1) worked examples: mode-1 binary, mode-2 graded beyond parity", () => {
    const ctx = CTX({ ctx: { usedBytes: 12e12 } });
    const split = { node: "pool", strategy: "split", n: 2, m: 1, lambdaCC: 0, members: [{ node: "kind", kind: "d", count: 3 }] };
    const m = buildPoolMachine(split, ctx, 1e6);
    // compositions of 3 disks into the 6 fixed member states (state layout is machine-internal)
    const states = [];
    const rec = (rem, idx, acc) => { if (idx === K_STATES - 1) { states.push(acc.concat(rem)); return; } for (let c = 0; c <= rem; c++) rec(rem - c, idx + 1, acc.concat(c)); };
    rec(3, 0, []);
    expect(m.nStates).toBe(states.length);
    states.forEach((c, i) => {
      const dead = 3 - c[0];
      expect(m.lostFraction[i]).toBe(dead > 1 ? 1 : 0);
      expect(m.lostFraction2[i]).toBeCloseTo(Math.max(0, dead - 1) / 3, 12);
    });
  });

  it("parent propagates child URE rate terms (mode 1 and mode 2 differ from URE-free base)", { timeout: 120000 }, () => {
    const ctx = CTX({ ctx: { usedBytes: 8e12 } });
    const child = { node: "pool", strategy: "split", n: 2, m: 1, lambdaCC: 0, members: [{ node: "kind", kind: "d", count: 3 }] };
    const parent = { node: "pool", strategy: "strip", d: 1, m: 1, lambdaCC: 0, members: [child, child] };
    const withUre = buildPoolMachine(parent, { ...ctx, kinds: { d: { ...ctx.kinds.d, ure: 1e-9 } } }, 1e6);
    const base = buildPoolMachine(parent, ctx, 1e6);
    expect(withUre.lossRate1.some((r) => r > 0)).toBe(true); // P0 regression: rates reach the parent
    const cUre = lossCurves(withUre, [0, 1e5]);
    const cBase = lossCurves(base, [0, 1e5]);
    expect(cUre.mode1[1]).toBeGreaterThan(cBase.mode1[1]);
    expect(cUre.mode2[1]).toBeGreaterThan(cBase.mode2[1]);
    expect(cUre.mode1[1]).toBeGreaterThan(cUre.mode2[1]); // rigorous >= partial
  });

  it("mode-1 expectation never exceeds 1 even with heavy URE", { timeout: 120000 }, () => {
    const ctx = CTX({ ctx: { usedBytes: 4e12 } });
    const machine = buildPoolMachine(
      { node: "pool", strategy: "strip", d: 3, m: 1, lambdaCC: 0, members: [{ node: "kind", kind: "d", count: 4 }] },
      { ...ctx, kinds: { d: { ...ctx.kinds.d, ure: 1e-8 } } }, 1e6,
    );
    const { mode1 } = lossCurves(machine, [0, 5e4, 1e5, 5e5]);
    mode1.forEach((v) => expect(v).toBeLessThanOrEqual(1 + 1e-9));
  });

  it("strip-split(2,1) worked examples match split semantics (disclosed convergence, §3.7)", () => {
    const ctx = CTX({ ctx: { usedBytes: 12e12 } });
    const ss = { node: "pool", strategy: "strip-split", n: 2, m: 1, lambdaCC: 0, members: [{ node: "kind", kind: "d", count: 3 }] };
    const m = buildPoolMachine(ss, ctx, 1e6);
    const states = [];
    const rec = (rem, idx, acc) => { if (idx === K_STATES - 1) { states.push(acc.concat(rem)); return; } for (let c = 0; c <= rem; c++) rec(rem - c, idx + 1, acc.concat(c)); };
    rec(3, 0, []);
    states.forEach((c, i) => {
      const dead = 3 - c[0];
      expect(m.lostFraction[i]).toBe(dead > 1 ? 1 : 0);
      expect(m.lostFraction2[i]).toBeCloseTo(Math.max(0, dead - 1) / 3, 12);
    });
  });

  it("rebuild contention: workload leftover reduces rebuild bandwidth (MTTR lengthens, MTTDL matches)", { timeout: 120000 }, () => {
    // RAID5 first-order MTTDL with contended MTTR: survivors read at R = readBW - wl.read
    const lambda = 1e-5, N = 4;
    const readBW = 1.12e8;
    const wlRead = 0.25 * readBW; // workload takes 25% of each survivor's read bandwidth
    const ctx = CTX({
      ctx: {
        usedBytes: 16e12,
        workload: { readBps: wlRead * 4, writeBps: 0, avgFileMB: 8 }, // 4 members x wlRead each
      },
    });
    const machine = buildPoolMachine(stripPool(3, 1), ctx, 1e6);
    const R = readBW - wlRead; // effective rebuild rate per member
    const MTTR = 4e12 / (R * 3600); // contended
    const MTTDL = 1 / (N * lambda * (N - 1) * lambda * MTTR);
    const tStar = 0.05 * MTTDL;
    const P = anyLossCurve(machine, [0, tStar])[1];
    const hazardNumeric = -Math.log(1 - P) / tStar;
    expect(hazardNumeric / (1 / MTTDL)).toBeGreaterThan(0.98);
    expect(hazardNumeric / (1 / MTTDL)).toBeLessThan(1.02);
    expect(machine.rebuildSlowdown).toBeCloseTo(readBW / R, 6); // 1/0.75 = 1.333
  });

  it("contention off: dedicated rebuildBw is used regardless of workload", () => {
    const ctx = CTX({
      global: { tOpH: 0, tSwapH: 0, tProcH: 0, rebuildBw: 5e7, contention: false },
      ctx: { usedBytes: 16e12, workload: { readBps: 8e7, writeBps: 0, avgFileMB: 8 } },
    });
    const machine = buildPoolMachine(stripPool(3, 1), ctx, 1e6);
    // memberUsed = 4e12 at dedicated 5e7 B/s -> tRebuild = 22.2h; no feasibility error despite
    // heavy workload; slowdown reported as 1 (dedicated channel)
    expect(machine.rebuildSlowdown).toBe(1);
    // regression: the rebuild-exit rate must be the DEDICATED rate 1/22.2h, not contended
    const exitRate = machine.transitions
      .filter((t) => t.to === 0 && t.rate > 0)
      .reduce((a, t) => a + t.rate, 0);
    expect(exitRate).toBeCloseTo(1 / (4e12 / (5e7 * 3600)), 6); // one rebuilding member exits at 1/tRebuild
  });

  it("infeasible workload: per-disk bandwidth exceeded throws", () => {
    const ctx = CTX({
      ctx: { usedBytes: 16e12, workload: { readBps: 5e8, writeBps: 0, avgFileMB: 8 } }, // 1.25e8 per disk > 1.12e8
    });
    expect(() => buildPoolMachine(stripPool(3, 1), ctx, 1e6)).toThrow(/exceeds disk bandwidth/);
  });

  it("fully saturated pool: no leftover bandwidth for rebuild throws", () => {
    const ctx = CTX({
      ctx: { usedBytes: 16e12, workload: { readBps: 4.4e8, writeBps: 0, avgFileMB: 8 } }, // exactly 1.1e8 per disk: leftover ~0.02e8, ok; push to 4.48e8 -> 1.12e8 = saturates
    });
    const sat = CTX({
      ctx: { usedBytes: 16e12, workload: { readBps: 4.48e8, writeBps: 0, avgFileMB: 8 } },
    });
    expect(() => buildPoolMachine(stripPool(3, 1), sat, 1e6)).toThrow(/saturates/);
    expect(() => buildPoolMachine(stripPool(3, 1), ctx, 1e6)).not.toThrow();
  });

  it("spares: stocked spare shortens the repair path vs procurement-only", { timeout: 180000 }, () => {
    // S=1 vs S=0: same pool, same rates — the spare path (tSwap) is shorter than procurement
    // (tProc), so P(any loss) over the horizon must be lower with a spare stocked
    const mk = (spares) => {
      const ctx = CTX({
        global: { tOpH: 12, tSwapH: 0.167, tProcH: 48, rebuildBw: 150e6, contention: true },
        ctx: { usedBytes: 4e12 },
      });
      ctx.kinds.d.spares = spares;
      return buildPoolMachine(
        { node: "pool", strategy: "strip", d: 3, m: 1, lambdaCC: 0, members: [{ node: "kind", kind: "d", count: 4 }] },
        ctx, 1e6,
      );
    };
    const withSpare = anyLossCurve(mk(1), [0, 1e5])[1];
    const without = anyLossCurve(mk(0), [0, 1e5])[1];
    expect(withSpare).toBeLessThan(without);
    expect(without).toBeGreaterThan(0);
  });

  it("kind shared across different parents is rejected (spare groups are sibling-scoped)", () => {
    const { validate, ConfigError } = require("../src/core/config.js");
    const cfg = {
      schemaVersion: 1,
      kinds: { d: { capacityTB: 4, lambdaBase: 1e-5, lambdaRead: 0, lambdaWrite: 0, ure: 0, readBW: 1e8, writeBW: 1e8, count: 8, spares: 1 } },
      tree: {
        node: "pool", strategy: "strip", d: 1, m: 1, lambdaCC: 0,
        members: [
          { node: "pool", strategy: "concat", lambdaCC: 0, members: [{ node: "kind", kind: "d", count: 1 }] },
          { node: "pool", strategy: "concat", lambdaCC: 0, members: [{ node: "kind", kind: "d", count: 1 }] },
        ],
      },
      global: { tOpH: 1, tSwapH: 1, tProcH: 1, rebuildBw: 1e8, contention: true },
      workload: { storeTB: 1, readBps: 0, writeBps: 0, avgFileMB: 8, horizonY: 1 },
    };
    // siblings under one parent: fine
    expect(() => validate(cfg)).not.toThrow();
    // same kind under two different top-level parents: rejected
    cfg.tree = {
      node: "pool", strategy: "concat", lambdaCC: 0,
      members: [
        { node: "pool", strategy: "strip", d: 1, m: 1, lambdaCC: 0, members: [{ node: "kind", kind: "d", count: 1 }] },
        { node: "pool", strategy: "strip", d: 1, m: 1, lambdaCC: 0, members: [{ node: "kind", kind: "d", count: 1 }] },
      ],
    };
    expect(() => validate(cfg)).toThrow(ConfigError);
  });

  it("common-cause shock: lambdaCC-only pool loses at exactly lambdaCC", () => {
    const ctx = CTX({ ctx: { usedBytes: 4e12 } });
    const machine = buildPoolMachine(
      {
        node: "pool",
        strategy: "strip",
        d: 3,
        m: 1,
        lambdaCC: 1e-5,
        members: [{ node: "kind", kind: "d", count: 4 }],
      },
      { ...ctx, kinds: { d: { ...ctx.kinds.d, lambdaBase: 0 } } },
      1e6,
    );
    const times = [0, 1e4, 1e5];
    const p = anyLossCurve(machine, times);
    times.forEach((t, i) =>
      expect(p[i]).toBeCloseTo(1 - Math.exp(-1e-5 * t), 9),
    );
  });

  it("URE during rebuild: corrupts stripes when parity is exhausted (M=1)", {
    timeout: 120000,
  }, () => {
    // no random deaths (lambda=0), long rebuild, meaningful URE: loss accumulates only while rebuilding
    const ctx = CTX({ ctx: { usedBytes: 4e12 } });
    const machine = buildPoolMachine(
      {
        node: "pool",
        strategy: "strip",
        d: 3,
        m: 1,
        lambdaCC: 0,
        members: [{ node: "kind", kind: "d", count: 4 }],
      },
      { ...ctx, kinds: { d: { ...ctx.kinds.d, lambdaBase: 0, ure: 1e-10 } } },
      1e6,
    );
    const times = [0, 1e3, 1e4];
    const p = anyLossCurve(machine, times);
    // with lambda=0 the pool never degrades on its own; URE only fires... verify no premature loss
    times.forEach((_t, i) => expect(p[i]).toBe(0));
    // now force a degraded state via tiny lambda and check URE adds loss beyond deaths alone
    const withDeaths = buildPoolMachine(
      {
        node: "pool",
        strategy: "strip",
        d: 3,
        m: 1,
        lambdaCC: 0,
        members: [{ node: "kind", kind: "d", count: 4 }],
      },
      { ...ctx, kinds: { d: { ...ctx.kinds.d, ure: 1e-10 } } },
      1e6,
    );
    const base = buildPoolMachine(stripPool(3, 1), ctx, 1e6);
    const pUre = anyLossCurve(withDeaths, [0, 1e5])[1];
    const pBase = anyLossCurve(base, [0, 1e5])[1];
    expect(pUre).toBeGreaterThan(pBase);
  });

  it("rejects a partially-loss child (concat) under a parent", () => {
    const child = {
      node: "pool",
      strategy: "concat",
      lambdaCC: 0,
      members: [{ node: "kind", kind: "d", count: 2 }],
    };
    const parent = {
      node: "pool",
      strategy: "strip",
      d: 1,
      m: 1,
      lambdaCC: 0,
      members: [child, child],
    };
    // usage spanning both concat members: 10TB over 2 children -> 5TB each -> child placement [4TB, 1TB]
    expect(() =>
      buildPoolMachine(parent, CTX({ ctx: { usedBytes: 10e12 } }), 1e6),
    ).toThrow(/concat children under parents/);
  });

  it("enforces the state-space budget", () => {
    expect(() =>
      buildPoolMachine(
        {
          node: "pool",
          strategy: "concat",
          lambdaCC: 0,
          members: [{ node: "kind", kind: "d", count: 8 }],
        },
        CTX({ ctx: { usedBytes: 4e12 } }),
        100,
      ),
    ).toThrow(/budget/);
  });
});
