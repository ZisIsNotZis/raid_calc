// CTMC solver: fixed-step RK4 (step = 1/maxRate, inside the stability region; accuracy verified
// against closed forms in tests) integrating dp/dt = p·Q.
// A machine exposes state-determined, path-monotone lostFraction(s), so
//   expectedLostFraction(t) = Σ_s p(s,t)·lf(s)
// is exact. P(any loss by t) comes from the killed chain (buildKilled) where loss transitions move
// into an absorbing "has-lost" half: P(any loss)(t) = probability mass in that half.
// Times in hours (rates are per hour).

export function buildKilled(machine) {
  const n = machine.nStates;
  const lf = new Float64Array(2 * n);
  for (let s = 0; s < n; s++) {
    lf[s] = machine.lostFraction[s];
    lf[s + n] = machine.lostFraction[s];
  }
  const transitions = [];
  for (const t of machine.transitions) {
    const lossEvent =
      machine.lostFraction[t.to] > machine.lostFraction[t.from] + 1e-15;
    transitions.push({
      from: t.from,
      to: lossEvent ? t.to + n : t.to,
      rate: t.rate,
    });
    transitions.push({ from: t.from + n, to: t.to + n, rate: t.rate });
  }
  return {
    nStates: 2 * n,
    transitions,
    lostFraction: lf,
    usedBytes: machine.usedBytes,
    initialState: machine.initialState ?? 0,
  };
}

function buildRows(machine) {
  const rows = Array.from({ length: machine.nStates }, () => []);
  const exit = new Float64Array(machine.nStates);
  for (const t of machine.transitions) {
    if (!(t.rate > 0)) continue;
    rows[t.from].push([t.to, t.rate]);
    exit[t.from] += t.rate;
  }
  let maxRate = 0;
  for (let i = 0; i < exit.length; i++)
    if (exit[i] > maxRate) maxRate = exit[i];
  return { rows, exit, maxRate };
}

function applyRows(rows, exit, p, out) {
  out.fill(0);
  for (let i = 0; i < p.length; i++) {
    const pi = p[i];
    if (pi === 0) continue;
    out[i] -= pi * exit[i];
    for (const [j, r] of rows[i]) out[j] += pi * r;
  }
}

// Returns the distribution at each requested time point (times[0] must be 0).
function integrate(machine, times) {
  const { rows, exit, maxRate } = buildRows(machine);
  const n = machine.nStates;
  const p = new Float64Array(n);
  p[machine.initialState ?? 0] = 1;
  const k1 = new Float64Array(n),
    k2 = new Float64Array(n),
    k3 = new Float64Array(n),
    k4 = new Float64Array(n),
    tmp = new Float64Array(n);
  const dtStep = maxRate > 0 ? 0.5 / maxRate : Infinity;
  const out = [Array.from(p)];
  for (let i = 1; i < times.length; i++) {
    let remaining = times[i] - times[i - 1];
    while (remaining > 1e-15) {
      const dt = Math.min(dtStep, remaining);
      applyRows(rows, exit, p, k1);
      for (let s = 0; s < n; s++) tmp[s] = p[s] + (dt / 2) * k1[s];
      applyRows(rows, exit, tmp, k2);
      for (let s = 0; s < n; s++) tmp[s] = p[s] + (dt / 2) * k2[s];
      applyRows(rows, exit, tmp, k3);
      for (let s = 0; s < n; s++) tmp[s] = p[s] + dt * k3[s];
      applyRows(rows, exit, tmp, k4);
      for (let s = 0; s < n; s++)
        p[s] += (dt / 6) * (k1[s] + 2 * k2[s] + 2 * k3[s] + k4[s]);
      let sum = 0;
      for (let s = 0; s < n; s++) sum += p[s];
      for (let s = 0; s < n; s++) p[s] /= sum;
      remaining -= dt;
    }
    out.push(Array.from(p));
  }
  return out;
}

function sumLf(machine, p) {
  let e = 0;
  for (let s = 0; s < p.length; s++) e += p[s] * machine.lostFraction[s];
  return e;
}

// times: increasing hours, times[0] === 0.
export function expectedLossCurve(machine, times) {
  const traj = integrate(machine, times);
  return traj.map((p) => sumLf(machine, p));
}

export function anyLossCurve(machine, times) {
  const killed = buildKilled(machine);
  const traj = integrate(killed, times);
  const half = machine.nStates;
  return traj.map((p) => {
    let a = 0;
    for (let s = half; s < p.length; s++) a += p[s];
    return a;
  });
}
