import { describe, it, expect } from "vitest";
import { concat, strip } from "../src/core/strategies/index.js";

describe("concat strategy (worked examples)", () => {
  const caps = [4e12, 4e12, 4e12];
  it("fills first-first", () => {
    expect(concat.placement(5e12, caps, {})).toEqual([4e12, 1e12, 0]);
  });
  it("loss: members beyond the frontier are free, inside members and the frontier member lose their bytes", () => {
    const used = concat.placement(5e12, caps, {});
    expect(concat.lossFraction([false, false, false], used, 5e12, {})).toBe(0);
    expect(concat.lossFraction([false, true, false], used, 5e12, {})).toBeCloseTo(1e12 / 5e12); // frontier member
    expect(concat.lossFraction([true, false, false], used, 5e12, {})).toBeCloseTo(4e12 / 5e12); // inside member
    expect(concat.lossFraction([false, false, true], used, 5e12, {})).toBe(0); // empty member — free
  });
  it("io follows placement shares", () => {
    const used = concat.placement(5e12, caps, {});
    const shares = concat.ioShares(used, 5e12, {});
    expect(shares[0].read).toBeCloseTo(0.8);
    expect(shares[2].read).toBe(0);
  });
});

describe("strip strategy (worked examples)", () => {
  const caps = Array.from({ length: 4 }, () => 8e12);
  it("spreads usage evenly across all members", () => {
    expect(strip.placement(16e12, caps, { d: 3, m: 1 })).toEqual([4e12, 4e12, 4e12, 4e12]);
  });
  it("loss: <=M dead is recoverable, >M dead loses everything (even at low usage)", () => {
    const used = strip.placement(4e12, caps, { d: 3, m: 1 }); // 25% usage
    expect(strip.lossFraction([false, true, false, false], used, 4e12, { d: 3, m: 1 })).toBe(0);
    expect(strip.lossFraction([false, true, true, false], used, 4e12, { d: 3, m: 1 })).toBe(1);
    expect(strip.lossFraction([true, true, true, true], used, 4e12, { d: 3, m: 1 })).toBe(1);
  });
  it("RAID0 (M=0) loses everything on any death", () => {
    const used = strip.placement(8e12, caps.slice(0, 3), { d: 3, m: 0 });
    expect(strip.lossFraction([true, false, false], used, 8e12, { d: 3, m: 0 })).toBe(1);
  });
  it("io fans out to every member equally", () => {
    const shares = strip.ioShares([4e12, 4e12, 4e12, 4e12], 16e12, { d: 3, m: 1 });
    shares.forEach((s) => expect(s.read).toBeCloseTo(0.25));
  });
});
