import { describe, it, expect } from "vitest";
import { simulate } from "../src/core/mc.js";
import { TB, HOURS_PER_YEAR } from "../src/core/config.js";

// tolerance helper: 3 standard errors of a Bernoulli-mean estimate
const within3SE = (got, expected, runs) =>
  Math.abs(got - expected) <= 3 * Math.sqrt((expected * (1 - expected)) / runs);

const baseConfig = (over = {}) => ({
  schemaVersion: 1,
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
      ...over.kind,
    },
  },
  tree: over.tree ?? { node: "kind", kind: "d", count: 1 },
  global: {
    tOpH: 0,
    tSwapH: 0,
    tProcH: 0,
    rebuildBw: 150e6,
    contention: true,
    ...over.global,
  },
  workload: {
    storeTB: over.storeTB ?? 4,
    readBps: 0,
    writeBps: 0,
    avgFileMB: 8,
    horizonY: 5,
    ...over.workload,
  },
});

describe("MC cross-check vs closed forms", () => {
  it("single disk: P(any loss)(t) within 3 SE of 1 - exp(-lambda t)", () => {
    const lambda = 1e-5;
    const runs = 20000;
    const r = simulate(baseConfig(), { runs, seed: 12345 });
    // check the 1y / 3y / 5y grid points (grid is linear over 5y = 43800h)
    [1, 3, 5].forEach((y) => {
      const i = Math.round((y * HOURS_PER_YEAR) / r.times[r.times.length - 1] * (r.times.length - 1));
      const expected = 1 - Math.exp(-lambda * r.times[i]);
      expect(within3SE(r.anyLossProb[i], expected, runs)).toBe(true);
      // rigorous mode == any-loss for a single disk (loss fraction is 0 or 1)
      expect(within3SE(r.expectedLostFraction[i], expected, runs)).toBe(true);
    });
  });

  it("RAID1 mirror: MC matches the analytic birth-death survival", { timeout: 120000 }, () => {
    const lambda = 1e-4; // raised for statistical power
    const horizonH = 2e5;
    const cfg = baseConfig({
      kind: { lambdaBase: lambda },
      tree: { node: "pool", strategy: "strip", d: 1, m: 1, lambdaCC: 0, members: [{ node: "kind", kind: "d", count: 2 }] },
      workload: { horizonY: horizonH / HOURS_PER_YEAR },
    });
    const runs = 20000;
    const r = simulate(cfg, { runs, points: 201, seed: 777 });
    // analytic (mirrors engine.test.js): per-member used = 2TB -> tRebuild = 4.96h
    const mu = 1 / (2e12 / (1.12e8 * 3600));
    const tr = -(3 * lambda + mu);
    const det = 2 * lambda * lambda;
    const disc = Math.sqrt(tr * tr - 4 * det);
    const r1 = (tr + disc) / 2, r2 = (tr - disc) / 2;
    const S = (t) => (r1 * Math.exp(r2 * t) - r2 * Math.exp(r1 * t)) / (r1 - r2);
    [5e4, 1e5, 1.5e5, 2e5].forEach((t) => {
      const i = Math.round((t / horizonH) * (r.times.length - 1));
      const expected = 1 - S(t);
      expect(within3SE(r.anyLossProb[i], expected, runs)).toBe(true);
    });
  });

  it("mode 2 never exceeds mode 1 (strip 3+1 with URE)", () => {
    const cfg = baseConfig({
      kind: { ure: 1e-10 },
      tree: { node: "pool", strategy: "strip", d: 3, m: 1, lambdaCC: 0, members: [{ node: "kind", kind: "d", count: 4 }] },
      storeTB: 12,
    });
    const r = simulate(cfg, { runs: 5000, seed: 99 });
    for (let i = 0; i < r.times.length; i++) {
      expect(r.expectedLostFractionPartial[i]).toBeLessThanOrEqual(
        r.expectedLostFraction[i] + 1e-12,
      );
    }
  });

  it("deterministic with a fixed seed", () => {
    const cfg = baseConfig();
    const a = simulate(cfg, { runs: 300, seed: 42 });
    const b = simulate(cfg, { runs: 300, seed: 42 });
    expect(JSON.stringify(a.expectedLostFraction)).toBe(JSON.stringify(b.expectedLostFraction));
    expect(JSON.stringify(a.anyLossProb)).toBe(JSON.stringify(b.anyLossProb));
    // different seed => (almost surely) different sample
    const c = simulate(cfg, { runs: 300, seed: 43 });
    expect(JSON.stringify(c.anyLossProb)).not.toBe(JSON.stringify(a.anyLossProb));
  });

  it("performance: 20k runs on a small machine under 30s", { timeout: 60000 }, () => {
    const t0 = Date.now();
    simulate(baseConfig(), { runs: 20000, seed: 1 });
    expect(Date.now() - t0).toBeLessThan(30000);
  });
});
