import { describe, it, expect } from "vitest";
import { validate, ConfigError, TB } from "../src/core/config.js";

const kind = (over = {}) => ({
  capacityTB: 8,
  lambdaBase: 2.8e-6,
  lambdaRead: 0.9e-12,
  lambdaWrite: 1.4e-12,
  ure: 7.9e-15,
  readBW: 190e6,
  writeBW: 170e6,
  count: 12,
  spares: 1,
  ...over,
});

const baseConfig = (over = {}) => ({
  schemaVersion: 1,
  kinds: { hdd8: kind() },
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
    storeTB: 20,
    readBps: 200e6,
    writeBps: 50e6,
    avgFileMB: 8,
    horizonY: 5,
  },
  ...over,
});

describe("config validation", () => {
  it("accepts a valid config", () => {
    const { usableBytes } = validate(baseConfig());
    expect(usableBytes).toBe(24 * TB); // strip(3,1) of 4x 8TB: 32TB raw x 3/4
  });

  it("rejects wrong schemaVersion", () => {
    expect(() => validate(baseConfig({ schemaVersion: 2 }))).toThrow(
      ConfigError,
    );
  });

  it("rejects unknown kind references", () => {
    const c = baseConfig();
    c.tree.members = [{ node: "kind", kind: "ssd", count: 4 }];
    expect(() => validate(c)).toThrow(/unknown kind/);
  });

  it("rejects wrong member counts for strip", () => {
    const c = baseConfig();
    c.tree.members = [{ node: "kind", kind: "hdd8", count: 5 }];
    expect(() => validate(c)).toThrow(/exactly 4/);
  });

  it("enforces the inventory rule (referenced + spares <= count)", () => {
    const c = baseConfig();
    c.kinds.hdd8.count = 4; // 4 referenced + 1 spare > 4
    expect(() => validate(c)).toThrow(/inventory/);
  });

  it("rejects storeTB above usable capacity", () => {
    const c = baseConfig({
      workload: {
        storeTB: 30,
        readBps: 0,
        writeBps: 0,
        avgFileMB: 8,
        horizonY: 5,
      },
    }); // usable 24TB
    expect(() => validate(c)).toThrow(/usable capacity/);
  });

  it("rejects non-finite kind params", () => {
    // object keys dedupe silently; guard via explicit check is unnecessary — but a kind with
    // non-finite params must fail
    const c = baseConfig();
    c.kinds.hdd8.lambdaBase = NaN;
    expect(() => validate(c)).toThrow(ConfigError);
  });
});
