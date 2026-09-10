// Top-level evaluation: config -> curves. Engine is pure; no state outside the config.

import { validate, TB, HOURS_PER_YEAR } from "./config.js";
import { buildPoolMachine } from "./machine.js";
import { lossCurves, anyLossCurve } from "./ctmc.js";

export { ConfigError } from "./config.js";
export { BuildError } from "./machine.js";

export const STATE_BUDGET = 1e6;

export function timePoints(horizonY, nPoints = 101) {
  const horizonH = horizonY * HOURS_PER_YEAR;
  return Array.from(
    { length: nPoints },
    (_, i) => (i / (nPoints - 1)) * horizonH,
  );
}

export function evaluate(
  config,
  { points = 101, stateBudget = STATE_BUDGET } = {},
) {
  const { usableBytes } = validate(config);
  const usedBytes = config.workload.storeTB * TB;

  let root = config.tree;
  if (root.node === "kind") {
    root = { node: "pool", strategy: "concat", lambdaCC: 0, members: [root] };
  }
  const ctx = {
    kinds: config.kinds,
    global: config.global,
    workload: config.workload,
    usedBytes,
  };
  const machine = buildPoolMachine(root, ctx, stateBudget);
  const times = timePoints(config.workload.horizonY, points);

  const { mode1, mode2 } = lossCurves(machine, times);
  const anyLossProb = anyLossCurve(machine, times);
  return {
    times, // hours
    expectedLostFraction: mode1, // mode 1 (rigorous): any corruption = file lost
    expectedLostFractionPartial: mode2, // mode 2 (partial): chunks lost beyond parity
    expectedLostBytes: mode1.map((f) => f * usedBytes),
    expectedLostBytesPartial: mode2.map((f) => f * usedBytes),
    anyLossProb,
    usedBytes,
    usableBytes,
    usageRatio: usedBytes / usableBytes,
    stateCount: machine.nStates,
  };
}
