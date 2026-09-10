import { describe, it, expect } from "vitest";
import { optimize } from "../src/core/optimizer.js";
import { evaluate } from "../src/core/evaluate.js";

const kind = {
  capacityTB: 8,
  lambdaBase: 2.8e-6,
  lambdaRead: 0.9e-12,
  lambdaWrite: 1.4e-12,
  ure: 7.9e-15,
  readBW: 190e6,
  writeBW: 170e6,
  count: 13,
  spares: 1,
};
const baseConfig = {
  schemaVersion: 1,
  kinds: { hdd8: kind },
  tree: {
    node: "pool",
    strategy: "strip",
    d: 3,
    m: 1,
    lambdaCC: 1e-7,
    members: [{ node: "kind", kind: "hdd8", count: 4 }],
  },
  global: {
    tOpH: 12,
    tSwapH: 10 / 60,
    tProcH: 48,
    rebuildBw: 150e6,
    contention: true,
  },
  workload: {
    storeTB: 40,
    readBps: 200e6,
    writeBps: 50e6,
    avgFileMB: 8,
    horizonY: 5,
  },
};

describe("optimizer", () => {
  it("small example: returns a feasible design within the state cap", {
    timeout: 240000,
  }, () => {
    // 8 disks, 20TB store, 2y horizon: designs that fit the v1 state cap are searchable
    const cfg = {
      ...baseConfig,
      kinds: { hdd8: { ...kind, count: 9 } },
      workload: { ...baseConfig.workload, storeTB: 20, horizonY: 1 },
    };
    const r = optimize(cfg, { budgetMs: 30000, stateCap: 20000 });
    expect(r.feasibleCount).toBeGreaterThan(0);
    expect(r.top3[0].usableTB).toBeGreaterThanOrEqual(20);
    expect(Number.isFinite(r.top3[0].lostBytes)).toBe(true);
    const r2 = evaluate(r.best, { points: 25 });
    expect(r2.usableBytes).toBeGreaterThan(0);
  });

  it("is deterministic (same input -> same best)", { timeout: 240000 }, () => {
    const cfg = {
      ...baseConfig,
      kinds: { hdd8: { ...kind, count: 9 } },
      workload: { ...baseConfig.workload, storeTB: 20, horizonY: 1 },
    };
    const a = optimize(cfg, { budgetMs: 8000, stateCap: 20000 });
    const b = optimize(cfg, { budgetMs: 8000, stateCap: 20000 });
    expect(JSON.stringify(a.best.tree)).toBe(JSON.stringify(b.best.tree));
    expect(a.top3[0].lostBytes).toBe(b.top3[0].lostBytes);
  });
});
