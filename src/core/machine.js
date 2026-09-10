// Machine model: a node's CTMC over its exact state space. A machine is:
//   { nStates, transitions, lostFraction, lostFraction2, lossRate1, lossRate2,
//     initialState, usedBytes, capacityBytes, usableBytes, rebuildSlowdown, bottleneckUtil,
//     eventCost1, eventCost2 }
// lostFraction (mode 1, rigorous) and lostFraction2 (mode 2, partial) are STATE-DETERMINED and
// monotone along paths; lossRate1/2 are continuous hazard terms (URE during rebuild) — see
// raid-calc.md §3.7: E[loss](t) = Σ p·lf + ∫ Σ p·ρ.
//
// Spare groups (§3.3): sibling disk-units of one kind share the global per-kind spare inventory
// as a joint state dimension s ∈ 0..S. Repair chain (§3.5): die → opwait (human, tOp) →
// swapping (consumes a spare, requires s ≥ 1; serial: one installer per unit, tSwap) or
// procuring (requires s == 0; delivery installs, tProc) → rebuilding (tRebuild) → aliveFull
// (parity restore, only while the unit's stripe group is intact: dead ≤ M) or aliveEmpty.
// Each stage's exit rate is 1/its own mean; zero-mean stages are skipped at transition level.
// v1 restriction: a kind used under more than one parent is rejected in config.js (split the
// kind into two kinds to model separate inventories).

import { strategies } from "./strategies/index.js";
import { BuildError as BuildErrorBase } from "./errors.js";
export const BuildError = BuildErrorBase;

export const K_STATES = 6; // aliveFull, opwait, swapping, rebuilding, procuring, aliveEmpty
const AF = 0, OPW = 1, SWP = 2, REB = 3, PROC = 4, AE = 5;

function memberCapacityBytes(ctx, m) {
  return m.node === "kind" ? ctx.kinds[m.kind].capacityTB * 1e12 : 0;
}

function expandMembers(node) {
  return node.members.flatMap((m) => (m.node === "kind" ? Array.from({ length: m.count }, () => m) : [m]));
}

// Rebuild plan per §3.5: leftover of the survivor's read bandwidth after workload; the fresh
// replacement writes at full writeBW. Contention off = dedicated rebuildBw.
function rebuildPlan(ctx, kind, usedBytes, wl) {
  if (wl.read > kind.readBW || wl.write > kind.writeBW) {
    throw new BuildError(
      `workload exceeds disk bandwidth: needs R ${wl.read.toExponential(2)} / W ${wl.write.toExponential(2)} B/s but the disk has ${kind.readBW} / ${kind.writeBW} — reduce the workload or add disks`,
    );
  }
  const idleBps = Math.min(kind.readBW, kind.writeBW);
  let rebuildBps;
  if (!ctx.global.contention) rebuildBps = ctx.global.rebuildBw;
  else {
    rebuildBps = Math.min(kind.readBW - wl.read, kind.writeBW);
    if (rebuildBps <= 0) {
      throw new BuildError(
        `workload saturates the pool: no leftover read bandwidth for rebuild (disk ${kind.readBW} B/s, workload reads ${wl.read.toExponential(2)} B/s) — add disks or reduce the workload`,
      );
    }
  }
  return {
    tRebuildH: usedBytes / (rebuildBps * 3600),
    slowdown: ctx.global.contention ? idleBps / rebuildBps : 1,
    utilization: Math.max(
      kind.readBW > 0 ? wl.read / kind.readBW : 0,
      kind.writeBW > 0 ? wl.write / kind.writeBW : 0,
    ),
  };
}

function diskLambda(ctx, kind, share) {
  return kind.lambdaBase
    + ctx.workload.readBps * share.read * kind.lambdaRead
    + ctx.workload.writeBps * share.write * kind.lambdaWrite;
}

function compositions(n, k, stateBudget = Infinity) {
  let count = 1;
  for (let i = 0; i < k - 1; i++) count = (count * (n + i + 1)) / (i + 1);
  if (count > stateBudget) {
    throw new BuildError(`state space ${Math.round(count)} exceeds budget ${stateBudget} — fewer members or shorter repair chains`);
  }
  const out = [];
  const rec = (remaining, idx, acc) => {
    if (idx === k - 1) { out.push(acc.concat(remaining)); return; }
    for (let c = 0; c <= remaining; c++) rec(remaining - c, idx + 1, acc.concat(c));
  };
  rec(n, 0, []);
  return out;
}

function bump(c, i) { const n = c.slice(); n[i]++; return n; }

// A unit model: one disk (N=1) or one erasure pool as a count model (N>1).
// lambda: { base (non-elevated death rate), wl {read, write} workload on this unit's disks }.
function unitModel({ N, kind, ctx, lambda, usedBytes, m, shockRate }) {
  const erasure = N > 1;
  const plan = rebuildPlan(ctx, kind, usedBytes, lambda.wl);
  plan._restoresFor = (d) => erasure && m.m >= 1 && d <= m.m;
  const states = compositions(N, K_STATES, ctx.stateBudget);
  const nStates = states.length;
  const keyOf = (c) => c.join(",");
  const index = new Map(states.map((s, i) => [keyOf(s), i]));
  const transitions = [];
  const add = (from, to, rate, extra = {}) => {
    if (!Number.isFinite(rate)) throw new BuildError(`non-finite transition rate (${from} -> ${to}) — check config inputs`);
    if (!(rate > 0)) return;
    transitions.push({ from, to, rate, ...extra });
  };
  const dead = (c) => N - c[AF];
  const lostFraction = new Float64Array(nStates);
  const lostFraction2 = new Float64Array(nStates);
  const lossRate1 = new Float64Array(nStates);
  const lossRate2 = new Float64Array(nStates);
  const rebThroughput = plan.tRebuildH > 0 ? usedBytes / 3600 / plan.tRebuildH : 0;
  const readsPerByte = !erasure ? 0 : m.strategy === "strip" ? N - 1 : N - m.m;
  const ureEventsPerHour = kind.ure * rebThroughput * readsPerByte * 3600;
  const perEvent1 = erasure ? ((N - m.m) / N) * (ctx.avgFileBytes / ctx.usedBytes) : 0;
  const perEvent2 = erasure ? ctx.avgFileBytes / N / ctx.usedBytes : 0;
  const shockTarget = index.get(keyOf(Array.from({ length: K_STATES }, (_, i) => (i === AE ? N : 0))));
  const restores = (d) => erasure && m.m >= 1 && d <= m.m;

  const move = (c, from, to) => { const n = c.slice(); n[from]--; n[to]++; return n; };
  states.forEach((c, s) => {
    const d = dead(c);
    lostFraction[s] = erasure && d > m.m ? 1 : 0;
    lostFraction2[s] = erasure ? Math.max(0, d - m.m) / N : 0;
    const rebuilding = c[REB] > 0;
    const deathRate = lambda.base + (rebuilding ? rebThroughput * kind.lambdaRead : 0);
    const emitConsume = (fromState, mult) => {
      if (ctx.global.tSwapH > 0) add(s, index.get(keyOf(move(c, fromState, SWP))), mult, { consumeSpare: true, needsSpare: true });
      else add(s, index.get(keyOf(move(c, fromState, REB))), mult, { consumeSpare: true, needsSpare: true });
    };
    const emitProcure = (fromState, mult) => {
      if (ctx.global.tProcH > 0) add(s, index.get(keyOf(move(c, fromState, PROC))), mult, { needsEmptySpares: true });
      else add(s, index.get(keyOf(move(c, fromState, REB))), mult, { needsEmptySpares: true });
    };
    // deaths enter the repair chain
    const die = (from) => { const n = c.slice(); n[from]--; n[OPW]++; return keyOf(n); };
    if (c[AF] > 0) {
      if (ctx.global.tOpH > 0) add(s, index.get(die(AF)), c[AF] * deathRate);
      else { emitConsume(AF, c[AF] * deathRate); emitProcure(AF, c[AF] * deathRate); }
    }
    if (c[AE] > 0) {
      if (ctx.global.tOpH > 0) add(s, index.get(die(AE)), c[AE] * lambda.base);
      else { emitConsume(AE, c[AE] * lambda.base); emitProcure(AE, c[AE] * lambda.base); }
    }
    // opwait exits at 1/tOp (the human stage's own duration)
    if (c[OPW] > 0 && ctx.global.tOpH > 0) {
      const rate = c[OPW] / ctx.global.tOpH;
      emitConsumeFromOpwait(rate);
      emitProcureFromOpwait(rate);
    }
    function emitConsumeFromOpwait(rate) {
      add(s, index.get(keyOf(move(c, OPW, ctx.global.tSwapH > 0 ? SWP : REB))), rate, { consumeSpare: true, needsSpare: true });
    }
    function emitProcureFromOpwait(rate) {
      add(s, index.get(keyOf(move(c, OPW, ctx.global.tProcH > 0 ? PROC : REB))), rate, { needsEmptySpares: true });
    }
    // stage internals: exit at 1/own mean
    const moveFrom = (from, to) => move(c, from, to);
    if (c[SWP] > 0 && ctx.global.tSwapH > 0) add(s, index.get(keyOf(moveFrom(SWP, REB))), c[SWP] / ctx.global.tSwapH);
    if (c[PROC] > 0 && ctx.global.tProcH > 0) add(s, index.get(keyOf(moveFrom(PROC, REB))), c[PROC] / ctx.global.tProcH);
    if (c[REB] > 0 && plan.tRebuildH > 0) {
      add(s, index.get(keyOf(moveFrom(REB, restores(d) ? AF : AE))), c[REB] / plan.tRebuildH);
    }
    // URE during rebuild: rate terms (occupancy-scaled; suppressed in saturated mode-1 states)
    if (rebuilding && ureEventsPerHour > 0) {
      const absorbed = erasure && m.m - d >= 1 ? 1 : 0;
      if (lostFraction[s] < 1 - 1e-12)
        lossRate1[s] = ureEventsPerHour * c[REB] * (1 - absorbed) * perEvent1;
      lossRate2[s] = ureEventsPerHour * c[REB] * (1 - absorbed) * perEvent2;
    }
    if (shockRate > 0) add(s, shockTarget, shockRate);
  });
  return {
    nStates, transitions, lostFraction, lostFraction2, lossRate1, lossRate2,
    initialState: index.get(keyOf(Array.from({ length: K_STATES }, (_, i) => (i === AF ? N : 0)))),
    eventCost1: perEvent1, eventCost2: perEvent2,
    capacityBytes: N * kind.capacityTB * 1e12,
    usableBytes: erasure ? N * kind.capacityTB * 1e12 * ((N - m.m) / N) : N * kind.capacityTB * 1e12,
    plan,
    states,
    N,
    lf1At: (i) => lostFraction[i],
    lf2At: (i) => lostFraction2[i],
    memberLostAt: (i) => (erasure ? (lostFraction[i] >= 1 - 1e-12 ? 1 : 0) : states[i][AF] < N ? 1 : 0),
    rate1At: (i) => lossRate1[i],
    rate2At: (i) => lossRate2[i],
  };
}

// Joint machine over sibling unit models sharing one spare dimension (S = kind.spares).
// lfFns: { mode1(states), mode2(states), weight(i) } — states = per-member state indices.
function modelsIdentical(models) {
  const key = (m) =>
    JSON.stringify([m.nStates, m.usedBytes, m.eventCost1, m.eventCost2, m.transitions]);
  return models.every((m) => key(m) === key(models[0]));
}

// Joint machine over sibling unit models sharing one spare dimension s ∈ 0..S.
// Identical member models are state-deduplicated: a joint state is the SORTED tuple of
// per-member state indices (a count multiset) + spare; the lift moves one member between
// states at rate mult = count(from) · rate. Heterogeneous members keep the ordered product.
function composeWithSpareGroup(models, S, stateBudget, lfFns) {
  const K = models.length;
  const identical = K > 1 && modelsIdentical(models);
  const k0 = models[0].nStates;
  let tuples;
  if (identical) {
    let count = 1;
    for (let i = 0; i < k0 - 1; i++) count = (count * (K + i + 1)) / (i + 1);
    if (count * (S + 1) > stateBudget) {
      throw new BuildError(`spare-group state space ${Math.round(count * (S + 1))} exceeds budget ${stateBudget} — fewer members, smaller spare stock, or shorter repair chains`);
    }
    tuples = compositions(K, k0);
  } else {
    let total = 1;
    for (const m of models) total *= m.nStates;
    if (total * (S + 1) > stateBudget) {
      throw new BuildError(`spare-group state space ${total * (S + 1)} exceeds budget ${stateBudget} — fewer members, smaller spare stock, or shorter repair chains`);
    }
    tuples = [];
    for (let v = 0; v < total; v++) {
      const t = Array.from({ length: K }, () => 0); let x = v;
      for (let i = 0; i < K; i++) { t[i] = x % models[i].nStates; x = Math.floor(x / models[i].nStates); }
      tuples.push(t);
    }
  }
  const nComps = tuples.length;
  const nStates = nComps * (S + 1);
  const keyOf = (t, spare) => t.join(",") + "|" + spare;
  const index = new Map();
  const stateTuples = [];
  for (const t of tuples) for (let sp = 0; sp <= S; sp++) {
    index.set(keyOf(t, sp), stateTuples.length);
    stateTuples.push({ t, spare: sp });
  }
  const decode = (idx) => stateTuples[idx];
  const add = (from, to, rate) => {
    if (!(rate > 0) || from === to) return;
    transMapSet(from, to, rate);
  };
  const transMap = new Map();
  function transMapSet(from, to, rate) {
    const key = from * nStates + to;
    transMap.set(key, (transMap.get(key) || 0) + rate);
  }
  // group transitions by from-state
  const byFrom = identical
    ? (() => { const g = Array.from({ length: k0 }, () => []); for (const tr of models[0].transitions) g[tr.from]?.push(tr); return g; })()
    : models.map((m) => { const g = Array.from({ length: m.nStates }, () => []); for (const tr of m.transitions) g[tr.from]?.push(tr); return g; });
  const lostFraction = new Float64Array(nStates);
  const lostFraction2 = new Float64Array(nStates);
  const lossRate1 = new Float64Array(nStates);
  const lossRate2 = new Float64Array(nStates);
  for (let idx = 0; idx < nStates; idx++) {
    const { t, spare } = decode(idx);
    // per-member state indices: ordered tuple -> identity; collapsed counts -> repeated
    const states = identical
      ? (() => { const xs = []; for (let a = 0; a < t.length; a++) for (let c = 0; c < t[a]; c++) xs.push(a); return xs; })()
      : [...t];
    lostFraction[idx] = lfFns.mode1(states);
    lostFraction2[idx] = lfFns.mode2(states);
    for (let i = 0; i < states.length; i++) {
      const w = lfFns.weight(i);
      const model = models[identical ? 0 : i];
      lossRate1[idx] += model.rate1At(states[i]) * w;
      lossRate2[idx] += model.rate2At(states[i]) * w;
    }
    const fireBucket = (fromBucket, toBucket, tr, mult) => {
      if (tr.needsSpare && spare < 1) return;
      if (tr.needsEmptySpares && spare !== 0) return;
      const next = t.slice();
      next[fromBucket]--;
      next[toBucket]++;
      const nextSpare = tr.consumeSpare ? spare - 1 : spare;
      add(idx, index.get(keyOf(next, nextSpare)), tr.rate * mult);
    };
    const fireMember = (memberIdx, tr) => {
      if (tr.needsSpare && spare < 1) return;
      if (tr.needsEmptySpares && spare !== 0) return;
      const next = t.slice();
      next[memberIdx] = tr.to;
      const nextSpare = tr.consumeSpare ? spare - 1 : spare;
      add(idx, index.get(keyOf(next, nextSpare)), tr.rate);
    };
    if (identical) {
      for (let a = 0; a < k0; a++) {
        if (t[a] === 0) continue;
        for (const tr of byFrom[a]) fireBucket(a, tr.to, tr, t[a]);
      }
    } else {
      for (let i = 0; i < K; i++) {
        for (const tr of byFrom[i][t[i]] || []) fireMember(i, tr);
      }
    }
  }
  const transitions = [...transMap.entries()].map(([key, rate]) => ({
    from: Math.floor(key / nStates), to: key % nStates, rate,
  }));
  const initialTuple = identical
    ? (() => { const t = Array.from({ length: k0 }, () => 0); t[models[0].initialState] = K; return t; })()
    : models.map((m) => m.initialState);
  const initialState = index.get(keyOf(initialTuple, S));
  if (initialState === undefined) throw new BuildError("spare-group initial state not found");
  return {
    nStates, transitions, lostFraction, lostFraction2, lossRate1, lossRate2,
    initialState,
    usedBytes: lfFns.usedBytes,
    capacityBytes: lfFns.capacityBytes,
    usableBytes: lfFns.usableBytes,
    rebuildSlowdown: lfFns.rebuildSlowdown,
    bottleneckUtil: lfFns.bottleneckUtil,
    eventCost1: models.map((m) => m.eventCost1),
    eventCost2: models.map((m) => m.eventCost2),
  };
}

// --- Erasure leaf (strip/split/strip-split): one pool unit + its spare dimension ---------------
function buildErasureLeaf(node, ctx, kind, members, memberUsed) {
  const model = erasureUnit(node, ctx, kind, memberUsed);
  return composeWithSpareGroup([model], kind.spares, ctx.stateBudget, {
    mode1: (st) => model.lf1At(st[0]),
    mode2: (st) => model.lf2At(st[0]),
    weight: () => 1,
    usedBytes: ctx.usedBytes,
    capacityBytes: model.capacityBytes,
    usableBytes: model.usableBytes,
    rebuildSlowdown: model.plan.slowdown,
    bottleneckUtil: model.plan.utilization,
  });
}

function erasureUnit(node, ctx, kind, memberUsed) {
  const N = expandMembers(node).length;
  const share = 1 / N;
  return unitModel({
    N, kind, ctx,
    lambda: {
      base: diskLambda(ctx, kind, { read: share, write: share }),
      wl: { read: ctx.workload.readBps * share, write: ctx.workload.writeBps * share },
    },
    usedBytes: memberUsed[0],
    m: node,
    shockRate: node.lambdaCC || 0,
  });
}

// --- Concat leaf: N independent disk units + spare dimension -----------------------------------
function buildConcatLeaf(node, ctx, kind, members, memberUsed) {
  const N = members.length;
  const ioShares = memberUsed.map((u) => (ctx.usedBytes > 0 ? u / ctx.usedBytes : 0));
  let maxSlowdown = 1;
  let maxUtil = 0;
  const models = members.map((_m, i) => diskUnit({
    ctx, kind, usedBytes: memberUsed[i],
    wl: { read: ctx.workload.readBps * ioShares[i], write: ctx.workload.writeBps * ioShares[i] },
    lambdaBase: diskLambda(ctx, kind, { read: ioShares[i], write: ioShares[i] }),
    onSlowdown: (v) => { maxSlowdown = Math.max(maxSlowdown, v); },
    onUtil: (v) => { maxUtil = Math.max(maxUtil, v); },
  }));
  const loss = (st) => {
    let lost = 0;
    for (let i = 0; i < N; i++) if (models[i].memberLostAt(st[i])) lost += memberUsed[i];
    return ctx.usedBytes > 0 ? lost / ctx.usedBytes : 0;
  };
  return composeWithSpareGroup(models, kind.spares, ctx.stateBudget, {
    mode1: loss,
    mode2: loss,
    weight: (i) => (ctx.usedBytes > 0 ? memberUsed[i] / ctx.usedBytes : 0),
    usedBytes: ctx.usedBytes,
    capacityBytes: N * kind.capacityTB * 1e12,
    usableBytes: N * kind.capacityTB * 1e12,
    rebuildSlowdown: maxSlowdown,
    bottleneckUtil: maxUtil,
  });
}

function diskUnit({ ctx, kind, usedBytes, wl, lambdaBase, onSlowdown, onUtil }) {
  const unit = unitModel({
    N: 1, kind, ctx,
    lambda: { base: lambdaBase, wl },
    usedBytes,
    m: { m: 0 }, // no erasure semantics
    shockRate: 0,
  });
  onSlowdown(unit.plan.slowdown);
  onUtil(unit.plan.utilization);
  return unit;
}

// --- Parent pools: children are leaf pools / bare disks of ONE kind (a spare group) ------------
function subtreeKind(node, ctx) {
  const kinds = new Set();
  const walk = (n) => {
    if (n.node === "kind") kinds.add(n.kind);
    else n.members.forEach(walk);
  };
  walk(node);
  if (kinds.size !== 1) throw new BuildError("mixed kinds within one subtree are not supported — use one kind per (sub)tree");
  return ctx.kinds[[...kinds][0]];
}

function buildParentMachine(node, ctx, stateBudget) {
  // NOTE (v1 scope): parent-level rebuild is not modeled as dynamics (a lost child is permanent
  // loss until a cluster extension models it); each level contends only with workload.
  // Cross-level concurrent-rebuild contention (§3.5's per-disk budget across levels) is deferred.
  const strategy = strategies[node.strategy];
  if (node.lambdaCC > 0) {
    throw new BuildError("common-cause shocks are leaf-pool-only in v1 (raid-calc.md §3.3) — set lambdaCC on leaf pools");
  }
  const caps = node.members.map((m) => memberCapacityBytes(ctx, m));
  const memberUsed = strategy.placement(ctx.usedBytes, caps, node);
  const wlShares = strategy.ioShares(memberUsed, ctx.usedBytes, node);
  const kinds = node.members.map((m) => subtreeKind(m, ctx));
  if (new Set(kinds).size > 1) {
    throw new BuildError("mixed kinds under one parent land with the spare-cluster extension — use one kind per parent for now");
  }
  const kind = kinds[0];
  const models = node.members.map((m, i) => {
    const childCtx = {
      ...ctx,
      usedBytes: memberUsed[i],
      workload: {
        ...ctx.workload,
        readBps: ctx.workload.readBps * wlShares[i].read,
        writeBps: ctx.workload.writeBps * wlShares[i].write,
      },
    };
    if (m.node === "kind") {
      // bare disk: no erasure semantics, repair never restores data
      return unitModel({
        N: 1, kind, ctx: childCtx,
        lambda: {
          base: diskLambda(childCtx, kind, { read: 1, write: 1 }),
          wl: { read: childCtx.workload.readBps, write: childCtx.workload.writeBps },
        },
        usedBytes: memberUsed[i],
        m: { m: 0 },
        shockRate: 0,
      });
    }
    if (m.node === "pool" && m.strategy === "concat") {
      throw new BuildError("concat children under parents are not supported in v1 (per-disk partial-loss nesting) — use erasure children under parents");
    }
    return erasureUnit(m, childCtx, kind, placementForChild(m, childCtx));
  });
  const lossFns = {
    mode1: (st) => strategy.lossFraction(models.map((m, i) => m.memberLostAt(st[i]) === 1), memberUsed, ctx.usedBytes, node),
    mode2: (st) => strategy.lossFraction2(models.map((m, i) => m.memberLostAt(st[i]) === 1), memberUsed, ctx.usedBytes, node),
    weight: (i) => (ctx.usedBytes > 0 ? memberUsed[i] / ctx.usedBytes : 0),
  };
  return composeWithSpareGroup(models, kind.spares, stateBudget, {
    mode1: lossFns.mode1,
    mode2: lossFns.mode2,
    weight: lossFns.weight,
    usedBytes: ctx.usedBytes,
    capacityBytes: caps.reduce((a, b) => a + b, 0),
    usableBytes: models.reduce((a, m) => a + m.usableBytes, 0) * strategy.usableFactor(node),
    rebuildSlowdown: models.reduce((a, m) => Math.max(a, m.plan.slowdown), 1),
    bottleneckUtil: models.reduce((a, m) => Math.max(a, m.plan.utilization), 0),
  });
}

// flatten helper: concat children expand into per-disk units in the state tuple? No — this v1
// keeps each concat child as ONE model (its own 6-state single-disk? no). A concat child under
// a parent is built as its own spare group internally? Simplification: a concat child under a
// parent is represented by its FIRST disk only is wrong — instead, mixed concat children under
// parents use the per-disk expansion via childStateOf below, which maps a flat per-child index.
function childStateOf(st, childIdx, _j, _cnt) {
  return st[childIdx];
}
void childStateOf;

function placementForChild(m, childCtx) {
  const strategy = strategies[m.strategy];
  const members = expandMembers(m);
  const caps = members.map((mm) => memberCapacityBytes(childCtx, mm));
  return strategy.placement(childCtx.usedBytes, caps, m);
}

// --- Entry --------------------------------------------------------------------
export function buildPoolMachine(node, ctx, stateBudget) {
  ctx = { ...ctx, stateBudget, avgFileBytes: ctx.workload.avgFileMB * 1e6 };
  const strategy = strategies[node.strategy];
  if (!strategy) throw new BuildError(`unknown strategy '${node.strategy}'`);
  const members = expandMembers(node);
  const allKind = members.every((m) => m.node === "kind");
  if (allKind) {
    const kindIds = new Set(members.map((m) => m.kind));
    if (kindIds.size > 1) throw new BuildError("mixed kinds within one leaf pool are not supported — use one kind per pool");
    const kind = ctx.kinds[[...kindIds][0]];
    const caps = members.map((m) => memberCapacityBytes(ctx, m));
    const memberUsed = strategy.placement(ctx.usedBytes, caps, node);
    if (node.strategy === "concat") return buildConcatLeaf(node, ctx, kind, members, memberUsed);
    return buildErasureLeaf(node, ctx, kind, members, memberUsed);
  }
  return buildParentMachine(node, ctx, stateBudget);
}
