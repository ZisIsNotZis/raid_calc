// Results: run evaluation, render charts + summary, per-node preview (debounced).
import { evaluate, ConfigError, BuildError } from "../core/evaluate.js";
import { validate } from "../core/config.js";
import { renderChart, evaluateSeries, fmtBytes } from "./charts.js";
import { TB, HOURS_PER_YEAR } from "../core/config.js";

export function runConfig(config, { points = 101, stateBudget } = {}) {
  return evaluate(config, { points, stateBudget });
}

// Returns { ok: true, result } or { ok: false, error } — never throws.
// Preview evaluations use a small state budget so oversized subtrees fail fast (BuildError)
// instead of blocking the main thread for minutes; the Run button evaluates with the full budget.
export function safeEvaluate(config, { stateBudget } = {}) { // no default cap: Run uses the full budget
  try {
    return { ok: true, result: runConfig(config, { stateBudget }) };
  } catch (err) {
    if (
      err instanceof ConfigError ||
      err instanceof BuildError ||
      err instanceof Error
    ) {
      return { ok: false, error: err.message };
    }
    return { ok: false, error: String(err) };
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

// Render charts into the output area (svg elements for E[lost] and P(any loss)).
export function renderOutputCharts({
  svgLost,
  svgP,
  result,
  _mode = 1,
  xLabel,
}) {
  const xl =
    xLabel || `${result.times[result.times.length - 1] / HOURS_PER_YEAR} y`;
  renderChart(svgLost, {
    width: 300,
    height: 110,
    series: [
      {
        label: "rigorous",
        x: result.times,
        y: evaluateSeries(result, { mode: 1, bytes: true }).y,
        color: "var(--accent)",
        dashed: false,
      },
      {
        label: "partial",
        x: result.times,
        y: evaluateSeries(result, { mode: 2, bytes: true }).y,
        color: "var(--accent2)",
        dashed: true,
      },
    ],
    xLabel: xl,
    yLabel: "E[lost] TB",
    logY: true,
  });
  renderChart(svgP, {
    width: 300,
    height: 110,
    series: [
      {
        label: "P(any loss)",
        x: result.times,
        y: result.anyLossProb,
        color: "var(--accent2)",
        dashed: false,
      },
    ],
    xLabel: xl,
    yLabel: "P(any loss)",
    logY: false,
  });
}

// Summary metrics (sidebar + output node).
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
  if (path && path.startsWith("kinds.")) {
    const id = path.slice(6);
    preview.tree = { node: "kind", kind: id, count: 1 };
  } else {
    preview.tree = nodeAt(config.tree, path);
  }
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
