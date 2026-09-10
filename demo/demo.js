// Demo: evaluates a 4x8TB RAID5 (strip 3+1) pool and a mirror, prints curve samples.
// Usage: node demo/demo.js
import { evaluate } from "../src/core/evaluate.js";
import { TB, HOURS_PER_YEAR } from "../src/core/config.js";

const kind = {
  capacityTB: 8,
  lambdaBase: 2.8e-6,
  lambdaRead: 0.9e-12,
  lambdaWrite: 1.4e-12,
  ure: 7.9e-15,
  readBW: 190e6,
  writeBW: 170e6,
  count: 9,
  spares: 1,
};
const config = (tree, storeTB) => ({
  schemaVersion: 1,
  kinds: { hdd8: kind },
  tree,
  global: {
    tOpH: 12,
    tSwapH: 10 / 60,
    tProcH: 48,
    rebuildBw: 150e6,
    contention: true,
  },
  workload: {
    storeTB,
    readBps: 200e6,
    writeBps: 50e6,
    avgFileMB: 8,
    horizonY: 5,
  },
});

const raid5 = {
  node: "pool",
  strategy: "strip",
  d: 3,
  m: 1,
  lambdaCC: 1e-7,
  members: [{ node: "kind", kind: "hdd8", count: 4 }],
};

const mirrorOfRaid5 = {
  node: "pool",
  strategy: "strip",
  d: 1,
  m: 1,
  lambdaCC: 0,
  members: [raid5, structuredClone(raid5)],
};

const say = (s) => process.stdout.write(s + "\n");

for (const [name, tree, store] of [
  ["RAID5 (4x 8TB, strip 3+1)", raid5, 24],
  ["Mirror of two RAID5 pools", mirrorOfRaid5, 24],
]) {
  const r = evaluate(config(tree, store));
  say(
    `\n=== ${name} — store ${store}TB, usable ${(r.usableBytes / TB).toFixed(0)}TB, states ${r.stateCount}`,
  );
  say("year  E[lost TB] (rigorous / partial)   P(any loss)");
  for (const y of [1, 3, 5]) {
    const i = Math.round(
      ((y * HOURS_PER_YEAR) / r.times[r.times.length - 1]) *
        (r.times.length - 1),
    );
    say(
      `${y}     ${(r.expectedLostBytes[i] / TB).toExponential(3)} / ${(r.expectedLostBytesPartial[i] / TB).toExponential(3)}      ${(r.anyLossProb[i] * 100).toFixed(4)}%`,
    );
  }
}
