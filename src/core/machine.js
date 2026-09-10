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
  constructor(m) { super(m); this.name = "BuildError"; }
}

const ALIVE_FULL = 0;

function memberCapacityBytes(ctx, m) {
  return m.node === "kind" ? ctx.kinds[m.kind].capacityTB * 1e12 : 0;
}

function expandMembers(node) {
  return node.members.flatMap((m) => (m.node === "kind" ? Array.from({ length: m.count }, () => m) : [m]));
}

function diskStageMeans(ctx, kind, usedBytes) {
  const rebuildBps = ctx.global.contention ? Math.min(kind.readBW, kind.writeBW) : ctx.global.rebuildBw;
  const tRebuildH = usedBytes / (rebuildBps * 3600);
  return [ctx.global.tOpH, ctx.global.tSwapH, tRebuildH].filter((m) => m > 0);
}

function diskLambda(ctx, kind, share) {
  return kind.lambdaBase
    + ctx.workload.readBps * share.read * kind.lambdaRead
    + ctx.workload.writeBps * share.write * kind.lambdaWrite;
}

// Compositions of n items into k buckets, as arrays.
function compositions(n, k) {
  const out = [];
  const rec = (remaining, idx, acc) => {
    if (idx === k - 1) { out.push(acc.concat(remaining)); return; }
    for (let c = 0; c <= remaining; c++) rec(remaining - c, idx + 1, acc.concat(c));
  };
  rec(n, 0, []);
  return out;
}

// --- Leaf pools (all members are physical disks of ONE kind) -----------------
function buildStripLeaf(node, ctx, kind, members, memberUsed) {
  const N = members.length;
  const share = 1 / N;
  const lambda = diskLambda(ctx, kind, { read: share, write: share });
  const stages = diskStageMeans(ctx, kind, memberUsed[0]);
  const k = stages.length + 2; // af, dead stages..., ae
  const ae = k - 1;
  const states = compositions(N, k);
  const nStates = states.length;
  const keyOf = (c) => c.join(",");
  const index = new Map(states.map((s, i) => [keyOf(s), i]));

  const dead = (c) => N - c[0];
  const lost = (c) => dead(c) > node.m;
  const lostFraction = new Float64Array(nStates);
  const transitions = [];
  const add = (from, to, rate) => {
    if (!(rate > 0)) return;
    transitions.push({ from, to, rate });
  };
  states.forEach((c, s) => {
    lostFraction[s] = lost(c) ? 1 : 0;
    if (lost(c)) return; // absorbing: data gone, pool abandoned
    // deaths: alive-full and alive-empty members die at lambda
    if (c[0] > 0) {
      const next = c.slice(); next[0]--; next[1]++;
      add(s, index.get(keyOf(next)), c[0] * lambda);
    }
    if (c[ae] > 0) {
      const next = c.slice(); next[ae]--; next[1]++;
      add(s, index.get(keyOf(next)), c[ae] * lambda);
    }
    // stage advances
    for (let i = 1; i < k - 2; i++) {
      if (c[i] > 0) {
        const next = c.slice(); next[i]--; next[i + 1]++;
        add(s, index.get(keyOf(next)), c[i] * (1 / stages[i - 1]));
      }
    }
    // rebuild exit from the last dead stage: parity restores the member (dead <= M here)
    const last = k - 2;
    if (stages.length > 0 && c[last] > 0) {
      const next = c.slice(); next[last]--; next[0]++;
      add(s, index.get(keyOf(next)), c[last] * (1 / stages[stages.length - 1]));
    }
  });
  void node;
  return {
    nStates, transitions, lostFraction,
    initialState: index.get(keyOf(Array.from({ length: k }, (_, i) => (i === 0 ? N : 0)))),
    usedBytes: ctx.usedBytes,
    capacityBytes: N * kind.capacityTB * 1e12,
    usableBytes: N * kind.capacityTB * 1e12 * (node.d / (node.d + node.m)),
  };
}

function buildConcatLeaf(node, ctx, kind, members, memberUsed) {
  const N = members.length;
  const ioShares = memberUsed.map((u) => (ctx.usedBytes > 0 ? u / ctx.usedBytes : 0));
  const lambdas = members.map((_m, i) => diskLambda(ctx, kind, { read: ioShares[i], write: ioShares[i] }));
  // per-member stage means differ (memberUsed differs) -> ordered tuples over per-member machines
  const machines = members.map((_m, i) => {
    const stages = diskStageMeans(ctx, kind, memberUsed[i]);
    const k = stages.length + 2;
    const transitions = [];
    const head = stages.length > 0 ? 1 : k - 1;
    transitions.push({ from: ALIVE_FULL, to: head, rate: lambdas[i] });
    for (let j = 0; j < stages.length; j++) {
      const to = j + 1 < stages.length ? j + 2 : k - 1;
      transitions.push({ from: j + 1, to, rate: 1 / stages[j] });
    }
    if (stages.length > 0) transitions.push({ from: k - 1, to: head, rate: lambdas[i] });
    const memberLost = new Uint8Array(k).fill(1);
    memberLost[ALIVE_FULL] = 0;
    return { nStates: k, transitions, memberLost, initialState: ALIVE_FULL };
  });
  const product = buildProduct(machines, ctx.stateBudget, false); // position-dependent: never collapse
  const totalUsed = ctx.usedBytes;
  const lostFraction = new Float64Array(product.nStates);
  for (let s = 0; s < product.nStates; s++) {
    const flags = product.states[s].map((si) => si !== ALIVE_FULL);
    lostFraction[s] = strategies.concat.lossFraction(flags, memberUsed, totalUsed, node);
  }
  return {
    nStates: product.nStates, transitions: product.transitions, lostFraction,
    initialState: product.initialState,
    usedBytes: ctx.usedBytes,
    capacityBytes: N * kind.capacityTB * 1e12,
    usableBytes: N * kind.capacityTB * 1e12,
  };
}

// --- Parent pools (compose child machines via exact product) ------------------
function sameMachine(a, b) {
  if (a.nStates !== b.nStates || a.usedBytes !== b.usedBytes) return false;
  if (String(a.memberLost) !== String(b.memberLost)) return false;
  const key = (t) => `${t.from}>${t.to}@${t.rate}`;
  return a.transitions.map(key).sort().join("|") === b.transitions.map(key).sort().join("|");
}

export function buildProduct(machines, stateBudget, allowCollapse = true) {
  const N = machines.length;
  const identical = allowCollapse && machines.every((m) => sameMachine(m, machines[0]));
  const k = machines[0].nStates;
  let states;
  if (identical) {
    states = compositions(N, k);
  } else {
    const total = k ** N;
    if (total > stateBudget) {
      throw new BuildError(`ordered product state space ${total} exceeds budget ${stateBudget} — simplify the design (fewer members, or parity instead of concat)`);
    }
    states = [];
    for (let s = 0; s < total; s++) {
      const t = Array.from({ length: N }, () => 0); let v = s;
      for (let i = 0; i < N; i++) { t[i] = v % k; v = Math.floor(v / k); }
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
        const next = c.slice(); next[t.from]--; next[t.to]++;
        add(index.get(keyOf(c)), index.get(keyOf(next)), t.rate * c[t.from]);
      }
    }
  } else {
    for (let p = 0; p < N; p++) {
      for (const t of machines[p].transitions) {
        for (const st of states) {
          if (st[p] !== t.from) continue;
          const next = st.slice(); next[p] = t.to;
          add(index.get(keyOf(st)), index.get(keyOf(next)), t.rate);
        }
      }
    }
  }
  const transitions = [...transMap.entries()].map(([key, rate]) => ({
    from: Math.floor(key / nStates), to: key % nStates, rate,
  }));
  let initial;
  if (identical) {
    const c = Array.from({ length: k }, () => 0);
    c[machines[0].initialState ?? 0] = N;
    initial = index.get(keyOf(c));
  } else {
    initial = index.get(keyOf(machines.map((m) => m.initialState ?? 0)));
  }
  return { states, nStates, transitions, identical, k, initialState: initial };
}

function buildParentMachine(node, ctx, stateBudget) {
  const strategy = strategies[node.strategy];
  const caps = node.members.map((m) => memberCapacityBytes(ctx, m));
  const memberUsed = strategy.placement(ctx.usedBytes, caps, node);

  const machines = node.members.map((m, i) => {
    if (m.node === "kind") {
      // bare disk as a pool member: no redundancy, death is permanent data loss
      const kind = ctx.kinds[m.kind];
      const machine = buildBareDiskMachine(ctx, kind, memberUsed[i], strategy.ioShares(memberUsed, ctx.usedBytes, node)[i]);
      machine.usableBytes = kind.capacityTB * 1e12;
      return machine;
    }
    const child = buildPoolMachine(m, { ...ctx, usedBytes: memberUsed[i] }, stateBudget);
    if (child.lostFraction.some((f) => f > 1e-12 && f < 1 - 1e-12)) {
      throw new BuildError("partially-loss child under a parent is not supported until mode-2 span accounting (ticket 06) — use parity-style children under parents");
    }
    child.memberLost = Uint8Array.from(child.lostFraction, (f) => (f >= 1 - 1e-12 ? 1 : 0));
    return child;
  });

  const product = buildProduct(machines, stateBudget, strategy.symmetricLoss === true);
  const lostFraction = new Float64Array(product.nStates);
  for (let s = 0; s < product.nStates; s++) {
    const st = product.states[s];
    let flags;
    if (product.identical) {
      flags = [];
      for (let a = 0; a < product.k; a++) {
        for (let c = 0; c < st[a]; c++) flags.push(machines[0].memberLost[a] === 1);
      }
    } else {
      flags = st.map((si, i) => machines[i].memberLost[si] === 1);
    }
    lostFraction[s] = strategy.lossFraction(flags, memberUsed, ctx.usedBytes, node);
  }
  const usable = machines.reduce((a, m) => a + (m.usableBytes ?? 0), 0);
  return {
    nStates: product.nStates, transitions: product.transitions, lostFraction,
    initialState: product.initialState,
    usedBytes: ctx.usedBytes,
    capacityBytes: caps.reduce((a, b) => a + b, 0),
    usableBytes: usable * strategy.usableFactor(node),
    lambdaCC: node.lambdaCC || 0,
  };
}

function buildBareDiskMachine(ctx, kind, usedBytes, share) {
  const lambda = diskLambda(ctx, kind, share);
  const stages = diskStageMeans(ctx, kind, usedBytes);
  const k = stages.length + 2;
  const transitions = [];
  const head = stages.length > 0 ? 1 : k - 1;
  transitions.push({ from: ALIVE_FULL, to: head, rate: lambda });
  for (let j = 0; j < stages.length; j++) {
    const to = j + 1 < stages.length ? j + 2 : k - 1;
    transitions.push({ from: j + 1, to, rate: 1 / stages[j] });
  }
  if (stages.length > 0) transitions.push({ from: k - 1, to: head, rate: lambda });
  const memberLost = new Uint8Array(k).fill(1);
  memberLost[ALIVE_FULL] = 0;
  return { nStates: k, transitions, memberLost, initialState: ALIVE_FULL, usableBytes: usedBytes };
}

// --- Entry --------------------------------------------------------------------
export function buildPoolMachine(node, ctx, stateBudget) {
  ctx = { ...ctx, stateBudget };
  const strategy = strategies[node.strategy];
  if (!strategy) throw new BuildError(`unknown strategy '${node.strategy}'`);
  if (node.strategy === "split" || node.strategy === "strip-split") {
    throw new BuildError(`strategy '${node.strategy}' lands in ticket 06 (erasure strategies)`);
  }
  const members = expandMembers(node);
  const kinds = members.map((m) => m.node === "kind" ? ctx.kinds[m.kind] : null);
  const allKind = members.every((m) => m.node === "kind");

  if (allKind) {
    const kindIds = new Set(members.map((m) => m.kind));
    if (kindIds.size > 1) throw new BuildError("mixed kinds within one leaf pool land with ticket 08 (heterogeneous members) — use one kind per pool for now");
    const caps = members.map((m) => memberCapacityBytes(ctx, m));
    const memberUsed = strategy.placement(ctx.usedBytes, caps, node);
    const kind = kinds[0];
    return node.strategy === "strip"
      ? buildStripLeaf(node, ctx, kind, members, memberUsed)
      : buildConcatLeaf(node, ctx, kind, members, memberUsed);
  }
  return buildParentMachine(node, ctx, stateBudget);
}
