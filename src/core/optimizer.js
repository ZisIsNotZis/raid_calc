// Auto-optimizer (docs/design/optimizer.md): greedy + local search over pool designs,
// feasibility via the engine (BuildError/ConfigError = infeasible), ranked by the objective.
// Deterministic: same input -> same result (lexicographic tie-break on config JSON).

import { evaluate, BuildError } from "./evaluate.js";
import { ConfigError } from "./config.js";

const ERASURE = ["strip", "split", "strip-split"];

function kindIds(config) {
  return Object.keys(config.kinds);
}

function kindCount(config, id) {
  return config.kinds[id].count - (config.kinds[id].spares || 0); // assignable disks
}

// --- Candidate generation -----------------------------------------------------
// A design = { pools: [{strategy, d/m/n, disks: kindId}], top: null | {strategy, n/m} }.
// Seeds cover the documented archetypes; local moves explore the neighborhood.
function seedsFor(kindId, total, workload) {
  const seeds = [];
  const groupSizes = [];
  for (let size = 2; size <= Math.min(total, 8); size++) groupSizes.push(size);
  // all-erasure groups of each size (top: none)
  for (const size of groupSizes) {
    const groups = Math.floor(total / size);
    if (groups < 1) continue;
    for (const strategy of ["strip", "split"]) {
      const pools = Array.from({ length: groups }, () => ({ strategy, disks: kindId, ...(strategy === "strip" ? { d: size - 1, m: 1 } : { n: size - 1, m: 1 }) }));
      seeds.push({ pools, top: null });
      if (size >= 3 && groups >= 2 && strategy === "strip") {
        pools.push({ strategy: "strip", disks: kindId, d: 1, m: 1 }); // + a mirror pool of leftovers
      }
    }
  }
  // one big erasure pool
  if (total >= 2) {
    seeds.push({ pools: [{ strategy: "strip", disks: kindId, d: total - 1, m: 1 }], top: null });
    if (total >= 3) seeds.push({ pools: [{ strategy: "split", disks: kindId, n: total - 1, m: 1 }], top: null });
    seeds.push({ pools: [{ strategy: "concat", disks: kindId }], top: null });
  }
  // mirrors of erasure halves (top strip(1,1) style over two pools)
  const half = Math.floor(total / 2);
  if (half >= 2) {
    const inner = half - 1;
    seeds.push({
      pools: [
        { strategy: "strip", disks: kindId, d: inner, m: 1 },
        { strategy: "strip", disks: kindId, d: inner, m: 1 },
      ],
      top: { strategy: "strip", d: 1, m: 1 },
    });
    seeds.push({
      pools: [
        { strategy: "split", disks: kindId, n: inner, m: 1 },
        { strategy: "split", disks: kindId, n: inner, m: 1 },
      ],
      top: { strategy: "split", n: 1, m: 1 },
    });
  }
  return seeds;
}

function designToConfig(design, base) {
  const members = design.pools.map((p) => {
    const pool = { node: "pool", strategy: p.strategy, lambdaCC: base.tree.lambdaCC ?? 0, members: [{ node: "kind", kind: p.disks, count: poolDiskCount(p) }] };
    if (p.strategy === "strip") { pool.d = p.d; pool.m = p.m ?? 0; }
    if (p.strategy === "split" || p.strategy === "strip-split") { pool.n = p.n; pool.m = p.m ?? 0; }
    return pool;
  });
  let tree;
  if (design.top) {
    tree = { node: "pool", strategy: design.top.strategy, lambdaCC: 0, members };
    if (design.top.strategy === "strip") { tree.d = design.top.d; tree.m = design.top.m ?? 0; }
    if (design.top.strategy === "split" || design.top.strategy === "strip-split") { tree.n = design.top.n; tree.m = design.top.m ?? 0; }
  } else if (members.length === 1) {
    tree = members[0];
  } else {
    tree = { node: "pool", strategy: "concat", lambdaCC: 0, members }; // concat top keeps it buildable
  }
  return { ...base, tree };
}

// Local moves: mutate pool sizes/params/strategies, add/remove pools, add/remove the top layer.
function localMoves(design, kindId, total) {
  const moves = [];
  const used = design.pools.reduce((a, p) => a + poolDiskCount(p), 0);
  const free = total - used;
  design.pools.forEach((p, i) => {
    // param tweaks
    if (p.strategy === "strip") {
      if (p.m === 0) moves.push(withPool(design, i, { ...p, m: 1 }));
      else moves.push(withPool(design, i, { ...p, m: 0 }));
      if (p.d > 1) moves.push(withPool(design, i, { ...p, d: p.d - 1 }));
      if (free > 0) moves.push(withPool(design, i, { ...p, d: p.d + 1 }));
    }
    if (p.strategy === "split" || p.strategy === "strip-split") {
      if (p.m < 2) moves.push(withPool(design, i, { ...p, m: p.m + 1 }));
      if (p.m > 0) moves.push(withPool(design, i, { ...p, m: p.m - 1 }));
      if (p.n > 1) moves.push(withPool(design, i, { ...p, n: p.n - 1 }));
      if (free > 0) moves.push(withPool(design, i, { ...p, n: p.n + 1 }));
    }
    // strategy conversion (same total disks where possible)
    if (p.strategy === "strip") moves.push(withPool(design, i, { ...p, strategy: "split", n: p.d, m: p.m }));
    if (p.strategy === "split") moves.push(withPool(design, i, { ...p, strategy: "strip", d: p.n, m: p.m }));
    if (p.strategy === "concat" && total >= 4) moves.push(withPool(design, i, { ...p, strategy: "strip", d: Math.max(1, total - 1), m: 1 }));
    // drop the pool
    if (design.pools.length > 1) moves.push({ pools: design.pools.filter((_p, j) => j !== i), top: design.top });
  });
  // add a pool from free disks
  if (free >= 2) moves.push({ pools: [...design.pools, { strategy: "strip", disks: kindId, d: free - 1, m: 1 }], top: design.top });
  // top layer moves
  if (!design.top && design.pools.length >= 2) {
    moves.push({ pools: design.pools, top: { strategy: "strip", d: design.pools.length - 1, m: 1 } });
    moves.push({ pools: design.pools, top: { strategy: "split", n: design.pools.length - 1, m: 1 } });
  }
  if (design.top) moves.push({ pools: design.pools, top: null });
  return moves.filter((d) => d.pools.every((p) => poolDiskCount(p) >= (p.strategy === "concat" ? 1 : (p.d ?? p.n) + (p.m ?? 0))) || true)
    .filter((d) => d.pools.reduce((a, p) => a + poolDiskCount(p), 0) <= total);
}

function poolDiskCount(p) {
  return p.strategy === "concat" ? 1 : (p.d ?? p.n) + (p.m ?? 0);
}

function withPool(design, i, pool) {
  return { pools: design.pools.map((p, j) => (j === i ? pool : p)), top: design.top };
}

// --- Search -------------------------------------------------------------------
// Rough joint-state estimate: Π per-pool C(disks+5, 5) x (S+1) (+ top-layer factor).
// Candidates above stateCap (default 5000) are SKIPPED — their CTMC solve would take minutes
// at multi-year horizons (disclosed v1 perf limitation; solver speedup is the top follow-up).
// Practical consequence: v1 optimizes within small joint state spaces; very large designs are
// excluded from search, not mis-ranked.
function estimatedStates(design, kinds) {
  const C = (n, k) => { let r = 1; for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1); return Math.round(r); };
  const S = Math.max(...Object.values(kinds).map((k) => k.spares || 0));
  let total = S + 1;
  for (const p of design.pools) {
    const n = poolDiskCount(p);
    total *= C(n + 5, 5); // compositions of n disks over 6 unit states
  }
  if (design.top) total *= C(design.pools.length + 5, 5);
  return total;
}
const K_STATES_BUCKETS = 6;

export function optimize(config, { objective = "lostBytes", budgetMs = 10000, candidateCap = 2000, stateCap = 5000 } = {}) {
  const started = Date.now();
  const base = JSON.parse(JSON.stringify(config));
  const kid = kindIds(base)[0];
  const total = kindCount(base, kid);
  if (total < 1) throw new ConfigError("optimizer: no assignable disks in inventory");

  const seen = new Set();
  const results = [];
  let feasible = 0;
  let evaluated = 0;
  let degraded = false;
  let skippedLarge = 0;

  const evaluateCandidate = (design) => {
    const key = JSON.stringify(design);
    if (seen.has(key)) return null;
    seen.add(key);
    if (seen.size > candidateCap) { degraded = true; return null; }
    if (Date.now() - started > budgetMs) { degraded = true; return null; }
    if (estimatedStates(design, base.kinds) > stateCap) { skippedLarge++; return null; }
    const cfg = designToConfig(design, base);
    try {
      const r = evaluate(cfg, { points: 25 });
      feasible++;
      const horizonIdx = r.times.length - 1;
      return {
        design, config: cfg,
        lostBytes: r.expectedLostBytes[horizonIdx],
        anyLossProb: r.anyLossProb[horizonIdx],
        usableTB: r.usableBytes / 1e12,
        bottleneckUtil: r.bottleneckUtil,
        rebuildSlowdown: r.rebuildSlowdown,
      };
    } catch (e) {
      if (e instanceof BuildError || e instanceof ConfigError) { evaluated++; return null; }
      throw e;
    }
  };

  const push = (candidate) => {
    if (!candidate) return;
    evaluated++;
    results.push(candidate);
  };

  // seeds first
  for (const seed of seedsFor(kid, total, base.workload)) push(evaluateCandidate(seed));
  // greedy local search from the current best
  let best = results.length ? results.reduce((a, b) => (objectiveOf(b, objective) < objectiveOf(a, objective) ? b : a)) : null;
  let iterations = 0;
  while (best && iterations < 50) {
    iterations++;
    let improved = null;
    for (const move of localMoves(best.design, kid, total)) {
      const candidate = evaluateCandidate(move);
      if (!candidate) continue;
      if (!improved || objectiveOf(candidate, objective) < objectiveOf(improved, objective)) improved = candidate;
    }
    if (!improved || objectiveOf(improved, objective) >= objectiveOf(best, objective) - 1e-15) break;
    best = improved;
  }

  if (results.length === 0) {
    throw new BuildError("optimizer: no feasible designs found for this inventory and workload");
  }
  results.sort((a, b) => objectiveOf(a, objective) - objectiveOf(b, objective) || JSON.stringify(a.config).localeCompare(JSON.stringify(b.config)));
  const top3 = results.slice(0, 3).map((c) => ({
    config: c.config, lostBytes: c.lostBytes, anyLossProb: c.anyLossProb,
    usableTB: c.usableTB, bottleneckUtil: c.bottleneckUtil, rebuildSlowdown: c.rebuildSlowdown,
  }));
  return {
    best: top3[0].config,
    top3,
    feasibleCount: feasible,
    evaluatedCount: evaluated,
    skippedLarge,
    degraded,
  };
}

function objectiveOf(candidate, objective) {
  return objective === "anyLoss" ? candidate.anyLossProb : candidate.lostBytes;
}
