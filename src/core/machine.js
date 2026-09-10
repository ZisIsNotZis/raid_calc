// Machine model: a node's CTMC over its exact product state space (symmetry-collapsed where members
// are interchangeable). A machine is:
//   { nStates, transitions: [{from, to, rate}], lostFraction: Float64Array(nStates),
//     usedBytes, capacityBytes, memberLost: Uint8Array(per member state) }
// lostFraction is STATE-DETERMINED and monotone along paths, so E[lost fraction](t) = Σ_s p(s,t)·lf(s).
// Disk members that died come back as "aliveEmpty" (capacity restored, data gone) unless the pool
// strategy's parity can reconstruct the member (rebuildRestoresData) — then back to "aliveFull".

import { strategies } from "./strategies/index.js";

export class BuildError extends Error {
  constructor(m) { super(m); this.name = "BuildError"; }
}

const ALIVE_FULL = 0;

// --- Disk member machine (leaf-pool building block) --------------------------
// States: aliveFull(0), dead stages 1..S, aliveEmpty(S+1). Zero-mean stages are skipped.
// Death (any alive state -> first dead stage) at `lambda`; stages advance at 1/mean; the last stage
// exits to aliveFull (parity restored the data) or aliveEmpty (no redundancy: bytes are gone).
export function buildDiskMachine({ lambda, stageMeans, rebuildRestoresData }) {
  const stageRates = stageMeans.filter((m) => m > 0).map((m) => 1 / m);
  const n = stageRates.length + 2;
  const aliveEmpty = n - 1;
  const target = rebuildRestoresData ? ALIVE_FULL : aliveEmpty;
  const transitions = [];
  const head = stageRates.length > 0 ? 1 : aliveEmpty;
  transitions.push({ from: ALIVE_FULL, to: head, rate: lambda });
  for (let i = 0; i < stageRates.length; i++) {
    const to = i + 1 < stageRates.length ? i + 2 : target;
    transitions.push({ from: i + 1, to, rate: stageRates[i] });
  }
  if (stageRates.length > 0) transitions.push({ from: aliveEmpty, to: head, rate: lambda });
  const memberLost = new Uint8Array(n).fill(1); // data lost in every state except aliveFull
  memberLost[ALIVE_FULL] = 0;
  return { nStates: n, transitions, memberLost, initialState: ALIVE_FULL };
}

// --- Product composition (exact; symmetry collapse for interchangeable members) ---------------
function sameMachine(a, b) {
  if (a.nStates !== b.nStates || a.usedBytes !== b.usedBytes) return false;
  if (String(a.memberLost) !== String(b.memberLost)) return false;
  const key = (t) => `${t.from}>${t.to}@${t.rate}`;
  const ta = a.transitions.map(key).sort().join("|");
  const tb = b.transitions.map(key).sort().join("|");
  return ta === tb;
}

export function buildProduct(machines, stateBudget, allowCollapse = true) {
  const N = machines.length;
  const identical = allowCollapse && machines.every((m) => sameMachine(m, machines[0]));
  const k = machines[0].nStates;
  let states;
  if (identical) {
    states = [];
    const rec = (remaining, idx, acc) => {
      if (idx === k - 1) { states.push(acc.concat(remaining)); return; }
      for (let c = 0; c <= remaining; c++) rec(remaining - c, idx + 1, acc.concat(c));
    };
    rec(N, 0, []);
  } else {
    const total = k ** N;
    if (total > stateBudget) {
      throw new BuildError(`ordered product state space ${total} exceeds budget ${stateBudget} — simplify the design (fewer members, or parity instead of concat)`);
    }
    states = [];
    for (let s = 0; s < total; s++) {
      const t = new Array(N).fill(0); let v = s;
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

function memberCapacityBytes(ctx, m) {
  return m.node === "kind" ? ctx.kinds[m.kind].capacityTB * 1e12 : 0;
}

// --- Pool machine builder ------------------------------------------------------
// node: {node:"pool", strategy, d/m/n, lambdaCC, members}
// ctx: {kinds, global, workload, usedBytes} — usedBytes was distributed top-down before this call.
// Children with non-binary lostFraction (partial loss, e.g. concat under a parent) are rejected:
// parent composition needs binary members until mode-2 span accounting lands (ticket 06).
export function buildPoolMachine(node, ctx, stateBudget) {
  const strategy = strategies[node.strategy];
  if (!strategy) throw new BuildError(`unknown strategy '${node.strategy}'`);
  if (node.strategy !== "concat" && node.strategy !== "strip") {
    throw new BuildError(`strategy '${node.strategy}' lands in ticket 06 (erasure strategies)`);
  }
  // kind refs with count k expand into k physical members (identical -> symmetry collapse applies)
  const members = node.members.flatMap((m) => (m.node === "kind" ? Array.from({ length: m.count }, () => m) : [m]));
  const caps = members.map((m) => memberCapacityBytes(ctx, m));
  const memberUsed = strategy.placement(ctx.usedBytes, caps, node);
  void caps;

  const machines = members.map((m, i) => {
    if (m.node === "kind") {
      const kind = ctx.kinds[m.kind];
      const share = strategy.ioShares(memberUsed, ctx.usedBytes, node)[i];
      const lambda = kind.lambdaBase
        + ctx.workload.readBps * share.read * kind.lambdaRead
        + ctx.workload.writeBps * share.write * kind.lambdaWrite;
      const rebuildBps = ctx.global.contention ? Math.min(kind.readBW, kind.writeBW) : ctx.global.rebuildBw;
      const tRebuildH = memberUsed[i] / (rebuildBps * 3600);
      const disk = buildDiskMachine({
        lambda,
        stageMeans: [ctx.global.tOpH, ctx.global.tSwapH, tRebuildH],
        rebuildRestoresData: strategy.rebuildRestoresData(node),
      });
      disk.usedBytes = memberUsed[i];
      disk.capacityBytes = kind.capacityTB * 1e12;
      return disk;
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

  return {
    nStates: product.nStates,
    transitions: product.transitions,
    lostFraction,
    initialState: product.initialState,
    usedBytes: ctx.usedBytes,
    capacityBytes: caps.reduce((a, b) => a + b, 0),
    lambdaCC: node.lambdaCC || 0, // leaf-level shocks arrive with ticket 08
  };
}
