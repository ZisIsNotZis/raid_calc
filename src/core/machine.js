// Machine model: a node's CTMC over its exact product state space (symmetry-collapsed where members
// are interchangeable). A machine is:
//   { nStates, transitions, lostFraction: Float64Array, initialState, usedBytes, capacityBytes }
// lostFraction is STATE-DETERMINED and MONOTONE along paths, so E[lost fraction](t) = Σ_s p(s,t)·lf(s).
// Monotonicity is structural:
//   - strip pools: states with dead > M are absorbing (data unrecoverable, pool abandoned);
//   - concat pools: rebuilt members return "aliveEmpty" (capacity back, bytes gone);
//   - parents compose children that satisfy the contract (verified binary lf per child state).

import { strategies } from "./strategies/index.js";

export class BuildError extends Error {
  constructor(m) {
    super(m);
    this.name = "BuildError";
  }
}

const ALIVE_FULL = 0;

function memberCapacityBytes(ctx, m) {
  return m.node === "kind" ? ctx.kinds[m.kind].capacityTB * 1e12 : 0;
}

function expandMembers(node) {
  return node.members.flatMap((m) =>
    m.node === "kind" ? Array.from({ length: m.count }, () => m) : [m],
  );
}

// Per-disk workload feasibility + leftover-bandwidth rebuild rate (raid-calc.md §3.5):
// rebuild reads run on survivors at R <= readBW - workload read; the replacement writes at
// full writeBW (a fresh disk serves no workload). Contention off = dedicated rebuildBw.
// Returns { stageMeans, rebuildBps, idleBps, slowdown } and throws on infeasible workload.
function rebuildPlan(ctx, kind, usedBytes, wl) {
  if (wl.read > kind.readBW || wl.write > kind.writeBW) {
    throw new BuildError(
      `workload exceeds disk bandwidth: disk '${kind.id ?? "kind"}' needs R ${wl.read.toExponential(2)} / W ${wl.write.toExponential(2)} B/s but has ${kind.readBW} / ${kind.writeBW} — reduce the workload or add disks`,
    );
  }
  let rebuildBps;
  let idleBps = Math.min(kind.readBW, kind.writeBW);
  if (!ctx.global.contention) {
    rebuildBps = ctx.global.rebuildBw;
  } else {
    rebuildBps = Math.min(kind.readBW - wl.read, kind.writeBW);
    if (rebuildBps <= 0) {
      throw new BuildError(
        `workload saturates the pool: no leftover read bandwidth for rebuild (disk ${kind.readBW} B/s, workload reads ${wl.read.toExponential(2)} B/s) — add disks or reduce the workload`,
      );
    }
  }
  const tRebuildH = usedBytes / (rebuildBps * 3600);
  const stageMeans = [ctx.global.tOpH, ctx.global.tSwapH, tRebuildH].filter(
    (m) => m > 0,
  );
  return {
    stageMeans,
    rebuildBps,
    idleBps,
    slowdown: ctx.global.contention && rebuildBps > 0 ? idleBps / rebuildBps : 1,
    utilization: Math.max(kind.readBW > 0 ? wl.read / kind.readBW : 0, kind.writeBW > 0 ? wl.write / kind.writeBW : 0),
  };
}

function diskLambda(ctx, kind, share) {
  return (
    kind.lambdaBase +
    ctx.workload.readBps * share.read * kind.lambdaRead +
    ctx.workload.writeBps * share.write * kind.lambdaWrite
  );
}

// Compositions of n items into k buckets, as arrays. Guarded by the state budget.
function compositions(n, k, stateBudget = Infinity) {
  let count = 1;
  for (let i = 0; i < k - 1; i++) count = (count * (n + i + 1)) / (i + 1);
  if (count > stateBudget) {
    throw new BuildError(
      `collapsed state space ${Math.round(count)} exceeds budget ${stateBudget} — fewer members or shorter repair chains`,
    );
  }
  const out = [];
  const rec = (remaining, idx, acc) => {
    if (idx === k - 1) {
      out.push(acc.concat(remaining));
      return;
    }
    for (let c = 0; c <= remaining; c++)
      rec(remaining - c, idx + 1, acc.concat(c));
  };
  rec(n, 0, []);
  return out;
}

// --- Leaf pools (all members are physical disks of ONE kind) -----------------
// Erasure leaves (strip / split / strip-split): parity restores members while dead <= M
// (rebuild exit lands alive-full); beyond M the exiting member lands alive-empty — the dead
// count is monotone, so both loss fractions are state-determined and monotone without
// absorbing states, and mode-2 losses accumulate as members die beyond parity.
// During rebuild, survivors read at the reconstruction rate (elevated hazard via lambdaRead)
// and carry URE hazard u per byte — a URE blocks reconstruction of one chunk unless the
// group still has spare parity (absorption factor per raid-calc.md §3.5). URE losses are
// RATE terms (machine.lossRate), not state jumps: E[loss](t) = Σ p·lf + ∫ Σ p·ρ.
// Common-cause shocks (lambdaCC, leaf-only per §3.3) kill all members at once.
function buildErasureLeaf(node, ctx, kind, members, memberUsed) {
  const N = members.length;
  const share = 1 / N;
  const lambda = diskLambda(ctx, kind, { read: share, write: share });
  const wlShare = {
    read: (ctx.workload.readBps * share),
    write: (ctx.workload.writeBps * share),
  };
  const plan = rebuildPlan(ctx, kind, memberUsed[0], wlShare);
  const stages = plan.stageMeans;
  const k = stages.length + 2; // af, dead stages..., ae
  const ae = k - 1;
  const states = compositions(N, k, ctx.stateBudget);
  const nStates = states.length;
  const keyOf = (c) => c.join(",");
  const index = new Map(states.map((s, i) => [keyOf(s), i]));

  const dead = (c) => N - c[0];
  const lostFraction = new Float64Array(nStates); // mode 1: any corruption of a file = file lost
  const lostFraction2 = new Float64Array(nStates); // mode 2: chunks lost beyond parity
  const lossRate1 = new Float64Array(nStates); // URE rate terms (per-hour expected-fraction increase)
  const lossRate2 = new Float64Array(nStates);
  const transitions = [];
  const add = (from, to, rate) => {
    if (!Number.isFinite(rate)) throw new BuildError(`non-finite transition rate (${from} -> ${to}) — check config for missing/invalid inputs`);
    if (!(rate > 0)) return;
    transitions.push({ from, to, rate });
  };
  // common-cause shock target: all members alive-empty
  const shockTarget = index.get(
    keyOf(Array.from({ length: k }, (_, i) => (i === ae ? N : 0))),
  );
  const rebThroughput =
    stages.length > 0 ? memberUsed[0] / 3600 / stages[stages.length - 1] : 0; // B/s
  // read-path per §3.2: strip reads N-1 survivors per rebuilt byte; split/strip-split read N
  const readsPerByte = node.strategy === "strip" ? N - 1 : N - node.m;
  const ureEventsPerHour = kind.ure * rebThroughput * readsPerByte * 3600; // survivor reads total
  // per-URE-event cost: the blocked chunk belonged to data with prob (N-m)/N; the group
  // holds one avg file (span approximation, raid-calc.md §3.7)
  const perEvent1 = ((N - node.m) / N) * (ctx.avgFileBytes / ctx.usedBytes);
  const perEvent2 = ctx.avgFileBytes / N / ctx.usedBytes;

  states.forEach((c, s) => {
    const d = dead(c);
    lostFraction[s] = d > node.m ? 1 : 0;
    lostFraction2[s] = Math.max(0, d - node.m) / N;
    const rebuilding = stages.length > 0 && c[k - 2] > 0;
    // survivor reads during rebuild elevate alive-member hazard (lambdaRead on rebuild reads)
    const deathRate =
      lambda + (rebuilding ? rebThroughput * kind.lambdaRead : 0);
    // deaths: alive-full and alive-empty members die
    if (c[0] > 0) {
      const next = c.slice();
      next[0]--;
      next[1]++;
      add(s, index.get(keyOf(next)), c[0] * deathRate);
    }
    if (c[ae] > 0) {
      const next = c.slice();
      next[ae]--;
      next[1]++;
      add(s, index.get(keyOf(next)), c[ae] * lambda);
    }
    // stage advances
    for (let i = 1; i < k - 2; i++) {
      if (c[i] > 0) {
        const next = c.slice();
        next[i]--;
        next[i + 1]++;
        add(s, index.get(keyOf(next)), c[i] * (1 / stages[i - 1]));
      }
    }
    // rebuild exit: the exiting member's chunks are reconstructable only while the stripe
    // group is intact (current dead <= M) — beyond that it lands alive-empty
    const last = k - 2;
    if (stages.length > 0 && c[last] > 0) {
      const restores = node.m >= 1 && d <= node.m;
      const next = c.slice();
      next[last]--;
      next[restores ? 0 : ae]++;
      add(s, index.get(keyOf(next)), c[last] * (1 / stages[stages.length - 1]));
    }
    // URE during rebuild: corrupts one chunk unless the group still has spare parity;
    // scales with the number of members rebuilding. Suppressed in fully-lost states for
    // mode 1 (already saturated — keeps E[mode 1] ≤ 1); mode 2 keeps accumulating.
    if (rebuilding && ureEventsPerHour > 0) {
      const absorbed = node.m - d >= 1 ? 1 : 0;
      const occupancy = c[last];
      if (lostFraction[s] < 1 - 1e-12)
        lossRate1[s] =
          ureEventsPerHour * occupancy * (1 - absorbed) * perEvent1;
      lossRate2[s] =
        ureEventsPerHour * occupancy * (1 - absorbed) * perEvent2;
    }
    // common-cause shock: all members die at once
    if (node.lambdaCC > 0) add(s, shockTarget, node.lambdaCC);
  });
  return {
    nStates,
    transitions,
    lostFraction,
    lostFraction2,
    lossRate1,
    lossRate2,
    initialState: index.get(
      keyOf(Array.from({ length: k }, (_, i) => (i === 0 ? N : 0))),
    ),
    usedBytes: ctx.usedBytes,
    capacityBytes: N * kind.capacityTB * 1e12,
    usableBytes: N * kind.capacityTB * 1e12 * ((N - node.m) / N),
    rebuildSlowdown: plan.slowdown,
    bottleneckUtil: plan.utilization,
  };
}

function buildConcatLeaf(node, ctx, kind, members, memberUsed) {
  const N = members.length;
  const ioShares = memberUsed.map((u) =>
    ctx.usedBytes > 0 ? u / ctx.usedBytes : 0,
  );
  const lambdas = members.map((_m, i) =>
    diskLambda(ctx, kind, { read: ioShares[i], write: ioShares[i] }),
  );
  // per-member stage means differ (memberUsed differs) -> ordered tuples over per-member machines
  let maxSlowdown = 1;
  let maxUtil = 0;
  const machines = members.map((_m, i) => {
    const wl = {
      read: ctx.workload.readBps * ioShares[i],
      write: ctx.workload.writeBps * ioShares[i],
    };
    const plan = rebuildPlan(ctx, kind, memberUsed[i], wl);
    maxSlowdown = Math.max(maxSlowdown, plan.slowdown);
    maxUtil = Math.max(maxUtil, plan.utilization);
    const stages = plan.stageMeans;
    const k = stages.length + 2;
    const transitions = [];
    const head = stages.length > 0 ? 1 : k - 1;
    transitions.push({ from: ALIVE_FULL, to: head, rate: lambdas[i] });
    for (let j = 0; j < stages.length; j++) {
      const to = j + 1 < stages.length ? j + 2 : k - 1;
      transitions.push({ from: j + 1, to, rate: 1 / stages[j] });
    }
    if (stages.length > 0)
      transitions.push({ from: k - 1, to: head, rate: lambdas[i] });
    const memberLost = new Uint8Array(k).fill(1);
    memberLost[ALIVE_FULL] = 0;
    return {
      nStates: k,
      transitions,
      memberLost,
      initialState: ALIVE_FULL,
      lossRate1: null,
      lossRate2: null,
    };
  });
  const product = buildProduct(machines, ctx.stateBudget, false); // position-dependent: never collapse
  const totalUsed = ctx.usedBytes;
  const lostFraction = new Float64Array(product.nStates);
  for (let s = 0; s < product.nStates; s++) {
    const flags = product.states[s].map((si) => si !== ALIVE_FULL);
    lostFraction[s] = strategies.concat.lossFraction(
      flags,
      memberUsed,
      totalUsed,
      node,
    );
  }
  // common-cause shock (leaf-only per §3.3): land in the all-alive-empty state (lf = 1)
  const transitions = product.transitions;
  if (node.lambdaCC > 0) {
    const lastStates = machines.map((m) => m.nStates - 1); // aliveEmpty is last in every disk machine
    const lostTarget = product.states.findIndex((t) =>
      t.every((si, i) => si === lastStates[i]),
    );
    if (lostTarget < 0)
      throw new BuildError(
        "cannot represent lambdaCC shock: no all-lost state exists",
      );
    for (let s = 0; s < product.nStates; s++) {
      if (lostFraction[s] < 1 - 1e-12 && s !== lostTarget)
        transitions.push({ from: s, to: lostTarget, rate: node.lambdaCC });
    }
  }
  return {
    nStates: product.nStates,
    transitions: product.transitions,
    lostFraction,
    lostFraction2: lostFraction, // no chunking: partial mode == rigorous mode
    lossRate1: new Float64Array(product.nStates),
    lossRate2: new Float64Array(product.nStates),
    initialState: product.initialState,
    usedBytes: ctx.usedBytes,
    capacityBytes: N * kind.capacityTB * 1e12,
    usableBytes: N * kind.capacityTB * 1e12,
    rebuildSlowdown: maxSlowdown,
    bottleneckUtil: maxUtil,
  };
}

// --- Parent pools (compose child machines via exact product) ------------------
function sameMachine(a, b) {
  if (a.nStates !== b.nStates || a.usedBytes !== b.usedBytes) return false;
  if (String(a.memberLost) !== String(b.memberLost)) return false;
  const key = (t) => `${t.from}>${t.to}@${t.rate}`;
  return (
    a.transitions.map(key).sort().join("|") ===
    b.transitions.map(key).sort().join("|")
  );
}

export function buildProduct(machines, stateBudget, allowCollapse = true) {
  const N = machines.length;
  const identical =
    allowCollapse && machines.every((m) => sameMachine(m, machines[0]));
  const k = machines[0].nStates;
  let states;
  if (identical) {
    states = compositions(N, k);
  } else {
    const radices = machines.map((m) => m.nStates);
    const total = radices.reduce((a, b) => a * b, 1);
    if (total > stateBudget) {
      throw new BuildError(
        `ordered product state space ${total} exceeds budget ${stateBudget} — simplify the design (fewer members, or parity instead of concat)`,
      );
    }
    states = [];
    for (let s = 0; s < total; s++) {
      const t = Array.from({ length: N }, () => 0);
      let v = s;
      for (let i = 0; i < N; i++) {
        t[i] = v % radices[i];
        v = Math.floor(v / radices[i]);
      }
      states.push(t);
    }
  }
  const keyOf = (t) => t.join(",");
  const index = new Map(states.map((s, i) => [keyOf(s), i]));
  const nStates = states.length;

  const transMap = new Map();
  const add = (from, to, rate) => {
    if (!(rate > 0) || from === to) return;
    const key = from * nStates + to;
    transMap.set(key, (transMap.get(key) || 0) + rate);
  };
  if (identical) {
    for (const t of machines[0].transitions) {
      for (const c of states) {
        if (c[t.from] === 0) continue;
        const next = c.slice();
        next[t.from]--;
        next[t.to]++;
        add(index.get(keyOf(c)), index.get(keyOf(next)), t.rate * c[t.from]);
      }
    }
  } else {
    for (let p = 0; p < N; p++) {
      for (const t of machines[p].transitions) {
        for (const st of states) {
          if (st[p] !== t.from) continue;
          const next = st.slice();
          next[p] = t.to;
          add(index.get(keyOf(st)), index.get(keyOf(next)), t.rate);
        }
      }
    }
  }
  const transitions = [...transMap.entries()].map(([key, rate]) => ({
    from: Math.floor(key / nStates),
    to: key % nStates,
    rate,
  }));
  let initial;
  if (identical) {
    const c = Array.from({ length: k }, () => 0);
    c[machines[0].initialState ?? 0] = N;
    initial = index.get(keyOf(c));
  } else {
    initial = index.get(keyOf(machines.map((m) => m.initialState ?? 0)));
  }
  if (initial === undefined)
    throw new BuildError(
      "product initial state not found — member initialState out of range",
    );
  return { states, nStates, transitions, identical, k, initialState: initial };
}

function buildParentMachine(node, ctx, stateBudget) {
  // NOTE (v1 scope): parent-level rebuild is not modeled as dynamics (a lost child is
  // permanent loss until ticket 08's spare model); each level contends only with workload.
  // Cross-level concurrent-rebuild contention (§3.5's per-disk budget across levels) lands
  // with ticket 08's spare/cluster work.
  const strategy = strategies[node.strategy];
  if (node.lambdaCC > 0) {
    throw new BuildError(
      "common-cause shocks are leaf-pool-only in v1 (raid-calc.md §3.3) — set lambdaCC on leaf pools",
    );
  }
  const caps = node.members.map((m) => memberCapacityBytes(ctx, m));
  const memberUsed = strategy.placement(ctx.usedBytes, caps, node);

  const machines = node.members.map((m, i) => {
    if (m.node === "kind") {
      // bare disk as a pool member: no redundancy, death is permanent data loss
      const kind = ctx.kinds[m.kind];
      const machine = buildBareDiskMachine(
        ctx,
        kind,
        memberUsed[i],
        strategy.ioShares(memberUsed, ctx.usedBytes, node)[i],
      );
      machine.usableBytes = kind.capacityTB * 1e12;
      return machine;
    }
    // scale the workload by this member's IO share before recursing (the parent's fan-out
    // decides how much of the top-level rate each member sees)
    const wlShare = strategy.ioShares(memberUsed, ctx.usedBytes, node)[i];
    const child = buildPoolMachine(
      m,
      {
        ...ctx,
        usedBytes: memberUsed[i],
        workload: {
          ...ctx.workload,
          readBps: ctx.workload.readBps * wlShare.read,
          writeBps: ctx.workload.writeBps * wlShare.write,
        },
      },
      stateBudget,
    );
    if (child.lostFraction.some((f) => f > 1e-12 && f < 1 - 1e-12)) {
      throw new BuildError(
        "partially-loss child under a parent is not supported (mode-2 nesting uses child-binary semantics, raid-calc.md §3.7) — use parity-style children whose mode-1 loss is binary",
      );
    }
    child.memberLost = Uint8Array.from(child.lostFraction, (f) =>
      f >= 1 - 1e-12 ? 1 : 0,
    );
    return child;
  });

  const product = buildProduct(
    machines,
    stateBudget,
    strategy.symmetricLoss === true,
  );
  const lostFraction = new Float64Array(product.nStates);
  const lostFraction2 = new Float64Array(product.nStates);
  const lossRate1 = new Float64Array(product.nStates);
  const lossRate2 = new Float64Array(product.nStates);
  for (let s = 0; s < product.nStates; s++) {
    const st = product.states[s];
    let flags;
    if (product.identical) {
      flags = [];
      for (let a = 0; a < product.k; a++) {
        for (let c = 0; c < st[a]; c++)
          flags.push(machines[0].memberLost[a] === 1);
      }
    } else {
      flags = st.map((si, i) => machines[i].memberLost[si] === 1);
    }
    lostFraction[s] = strategy.lossFraction(
      flags,
      memberUsed,
      ctx.usedBytes,
      node,
    );
    lostFraction2[s] = strategy.lossFraction2(
      flags,
      memberUsed,
      ctx.usedBytes,
      node,
    );
    // child URE rate terms propagate weighted by the child's share of parent used bytes;
    // nested mode-2 beyond that uses child-binary semantics (disclosed approximation,
    // raid-calc.md §3.7)
    for (let i = 0; i < node.members.length; i++) {
      const child = machines[i];
      const w = ctx.usedBytes > 0 ? memberUsed[i] / ctx.usedBytes : 0;
      if (!child.lossRate1 && !child.lossRate2) continue;
      if (product.identical) {
        for (let a = 0; a < product.k; a++) {
          if (st[a] === 0) continue;
          lossRate1[s] += (child.lossRate1?.[a] || 0) * st[a] * w;
          lossRate2[s] += (child.lossRate2?.[a] || 0) * st[a] * w;
        }
      } else {
        const si = st[i];
        lossRate1[s] += (child.lossRate1?.[si] || 0) * w;
        lossRate2[s] += (child.lossRate2?.[si] || 0) * w;
      }
    }
  }
  const usable = machines.reduce((a, m) => a + (m.usableBytes ?? 0), 0);
  const rebuildSlowdown = machines.reduce((a, m) => Math.max(a, m.rebuildSlowdown ?? 1), 1);
  const bottleneckUtil = machines.reduce((a, m) => Math.max(a, m.bottleneckUtil ?? 0), 0);
  return {
    nStates: product.nStates,
    transitions: product.transitions,
    lostFraction,
    lostFraction2,
    lossRate1,
    lossRate2,
    initialState: product.initialState,
    usedBytes: ctx.usedBytes,
    capacityBytes: caps.reduce((a, b) => a + b, 0),
    usableBytes: usable * strategy.usableFactor(node),
    rebuildSlowdown,
    bottleneckUtil,
    lambdaCC: node.lambdaCC || 0,
  };
}

function buildBareDiskMachine(ctx, kind, usedBytes, share) {
  const lambda = diskLambda(ctx, kind, share);
  const wl = {
    read: ctx.workload.readBps * share.read,
    write: ctx.workload.writeBps * share.write,
  };
  const plan = rebuildPlan(ctx, kind, usedBytes, wl);
  const stages = plan.stageMeans;
  const k = stages.length + 2;
  const transitions = [];
  const head = stages.length > 0 ? 1 : k - 1;
  transitions.push({ from: ALIVE_FULL, to: head, rate: lambda });
  for (let j = 0; j < stages.length; j++) {
    const to = j + 1 < stages.length ? j + 2 : k - 1;
    transitions.push({ from: j + 1, to, rate: 1 / stages[j] });
  }
  if (stages.length > 0)
    transitions.push({ from: k - 1, to: head, rate: lambda });
  const memberLost = new Uint8Array(k).fill(1);
  memberLost[ALIVE_FULL] = 0;
  return {
    nStates: k,
    transitions,
    memberLost,
    initialState: ALIVE_FULL,
    usableBytes: usedBytes,
    rebuildSlowdown: plan.slowdown,
    bottleneckUtil: plan.utilization,
  };
}

// --- Entry --------------------------------------------------------------------
export function buildPoolMachine(node, ctx, stateBudget) {
  ctx = { ...ctx, stateBudget, avgFileBytes: ctx.workload.avgFileMB * 1e6 };
  const strategy = strategies[node.strategy];
  if (!strategy) throw new BuildError(`unknown strategy '${node.strategy}'`);
  const members = expandMembers(node);
  const kinds = members.map((m) =>
    m.node === "kind" ? ctx.kinds[m.kind] : null,
  );
  const allKind = members.every((m) => m.node === "kind");

  if (allKind) {
    const kindIds = new Set(members.map((m) => m.kind));
    if (kindIds.size > 1)
      throw new BuildError(
        "mixed kinds within one leaf pool land with ticket 08 (heterogeneous members) — use one kind per pool for now",
      );
    const caps = members.map((m) => memberCapacityBytes(ctx, m));
    const memberUsed = strategy.placement(ctx.usedBytes, caps, node);
    const kind = kinds[0];
    return node.strategy === "concat"
      ? buildConcatLeaf(node, ctx, kind, members, memberUsed)
      : buildErasureLeaf(node, ctx, kind, members, memberUsed);
  }
  return buildParentMachine(node, ctx, stateBudget);
}
