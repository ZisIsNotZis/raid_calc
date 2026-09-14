// Results: run evaluation, render charts + summary, per-node preview (debounced).
import { evaluate } from "../core/evaluate.js";
import { validate } from "../core/config.js";
import { fmtBytes } from "./charts.js";
import { TB, HOURS_PER_YEAR, usableBytesOf } from "../core/config.js";

export function runConfig(config, { points, stateBudget } = {}) {
  return evaluate(config, { points, stateBudget });
}

// Returns { ok: true, result } or { ok: false, error } — never throws.
// Preview evaluations use a small state budget so oversized subtrees fail fast (BuildError)
// instead of blocking the main thread for minutes; the Run button evaluates with the full budget.
export function safeEvaluate(config, { stateBudget, points } = {}) { // no default cap: Run uses the full budget
  try {
    return { ok: true, result: runConfig(config, { stateBudget, points }) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Validate-only gate for the Run button.
export function validationError(config) {
  try {
    validate(config);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// Summary metrics (root ribbon, drawer, sidebar).
export function summarize(result) {
  const last = result.times.length - 1;
  return {
    horizonY: +(result.times[last] / HOURS_PER_YEAR).toFixed(2),
    lostBytes: result.expectedLostBytes[last],
    lostBytesPartial: result.expectedLostBytesPartial[last],
    anyLoss: result.anyLossProb[last],
    usableBytes: result.usableBytes,
    usedBytes: result.usedBytes,
    usageRatio: result.usageRatio,
    rebuildSlowdown: result.rebuildSlowdown,
    bottleneckUtil: result.bottleneckUtil,
    stateCount: result.stateCount,
  };
}

export function fmtSummary(summary) {
  return {
    horizon: `${summary.horizonY} y`,
    lost: fmtBytes(summary.lostBytes),
    lostPartial: fmtBytes(summary.lostBytesPartial),
    anyLossPct: `${(summary.anyLoss * 100).toFixed(3)}%`,
    usable: `${(summary.usableBytes / TB).toFixed(0)} TB`,
    used: `${(summary.usedBytes / TB).toFixed(0)} TB`,
    usage: `${(summary.usageRatio * 100).toFixed(0)}%`,
    slowdown: `×${summary.rebuildSlowdown.toFixed(2)}`,
    bottleneck: `${(summary.bottleneckUtil * 100).toFixed(0)}%`,
    states: String(summary.stateCount),
  };
}

// Per-node standalone preview: evaluate a config whose tree is just that subtree.
// Debounced by the caller (raid-calc.md §3: the graph doubles as an understanding tool).
export function previewConfig(config, path) {
  const preview = structuredClone(config);
  const subtree =
    path && path.startsWith("kinds.")
      ? { node: "kind", kind: path.slice(6), count: 1 }
      : nodeAt(config.tree, path);
  preview.tree = subtree;
  // Scale the workload to the subtree's share of top-level usable capacity (ui.md §5). Without this
  // a small subtree would fail validation outright ("storeTB exceeds usable capacity") and its curve
  // would never render.
  const totalUsable = usableBytesOf(config.tree, config.kinds) || 0;
  const subUsable = usableBytesOf(subtree, config.kinds) || 0;
  const share = totalUsable > 0 ? Math.min(1, subUsable / totalUsable) : 1;
  const w = config.workload || {};
  preview.workload = {
    ...w,
    storeTB: Math.max(
      1e-6,
      Math.min((w.storeTB || 0) * share, (subUsable / TB) * 0.999),
    ),
    readBps: (w.readBps || 0) * share,
    writeBps: (w.writeBps || 0) * share,
  };
  return preview;
}

function nodeAt(node, path) {
  if (!path || path === "tree") return node;
  const parts = path.split(".");
  let cur = node;
  for (const part of parts.slice(1)) {
    const m = /^members\[(\d+)\]$/.exec(part);
    if (m) cur = cur.members[Number(m[1])];
    else if (Object.hasOwn(cur, part)) cur = cur[part];
    else throw new Error(`unknown config path segment '${part}'`);
  }
  return cur;
}
