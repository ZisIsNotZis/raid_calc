// CTMC solver: fixed-step RK4 (step = 0.5/maxRate, inside the stability region; accuracy verified
// against closed forms in tests) integrating dp/dt = p·Q.
// A machine exposes state-determined, path-monotone loss fractions lf1 (rigorous) and lf2
// (partial), plus optional per-state RATE terms rho1/rho2 (continuous hazard, e.g. URE during
// rebuild). Expected losses combine both, exact by linearity:
//   E_mode(t) = Σ_s p(s,t)·lf_mode(s) + ∫₀ᵗ Σ_s p(s,t')·rho_mode(s) dt'
// P(any loss by t) comes from the killed chain (buildKilled) where loss transitions and rho1
// events move into an absorbing "has-lost" half: P(any loss)(t) = probability mass in that half.
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
  // rate-based loss events (e.g. URE): any-loss fires from the clean half at rho1
  if (machine.lossRate1) {
    for (let s = 0; s < n; s++) {
      if (machine.lossRate1[s] > 0)
        transitions.push({ from: s, to: s + n, rate: machine.lossRate1[s] });
    }
  }
  return {
    nStates: 2 * n,
    transitions,
    lostFraction: lf,
    usedBytes: machine.usedBytes,
    initialState: machine.initialState ?? 0,
  };
}

// CSR-style flat storage: much faster inner loop than array-of-arrays for large machines.
function buildRows(machine) {
  const n = machine.nStates;
  const counts = new Int32Array(n);
  const finite = machine.transitions.filter((t) => t.rate > 0 && Number.isFinite(t.rate) && Number.isFinite(t.from) && Number.isFinite(t.to));
  for (const t of finite) counts[t.from]++;
  const rowStart = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) rowStart[i + 1] = rowStart[i] + counts[i];
  const targets = new Int32Array(finite.length);
  const rates = new Float64Array(finite.length);
  const fill = rowStart.slice();
  const exit = new Float64Array(n);
  for (const t of finite) {
    targets[fill[t.from]] = t.to;
    rates[fill[t.from]] = t.rate;
    fill[t.from]++;
    exit[t.from] += t.rate;
  }
  let maxRate = 0;
  for (let i = 0; i < n; i++) if (exit[i] > maxRate) maxRate = exit[i];
  return { rowStart, targets, rates, exit, maxRate };
}

function applyRows(rowStart, targets, rates, exit, p, out) {
  out.fill(0);
  const n = p.length;
  for (let i = 0; i < n; i++) {
    const pi = p[i];
    if (pi === 0) continue;
    out[i] -= pi * exit[i];
    const e = rowStart[i + 1];
    for (let k = rowStart[i]; k < e; k++) out[targets[k]] += pi * rates[k];
  }
}

function rateSum(rho, p) {
  if (!rho) return 0;
  let e = 0;
  for (let s = 0; s < p.length; s++) e += p[s] * rho[s];
  return e;
}

function sumLf(lf, p) {
  let e = 0;
  for (let s = 0; s < p.length; s++) e += p[s] * lf[s];
  return e;
}

// Integrates p(t) and the two rate-term integrals; returns per-time-point arrays.
function integrate(machine, times) {
  const { rowStart, targets, rates, exit, maxRate } = buildRows(machine);
  const n = machine.nStates;
  const rho1 = machine.lossRate1;
  const rho2 = machine.lossRate2;
  const p = new Float64Array(n);
  p[machine.initialState ?? 0] = 1;
  const k1 = new Float64Array(n),
    k2 = new Float64Array(n),
    k3 = new Float64Array(n),
    k4 = new Float64Array(n),
    tmp = new Float64Array(n);
  const dtStep = maxRate > 0 ? 0.5 / maxRate : Infinity;
  const traj = [Array.from(p)];
  const int1 = [0];
  const int2 = [0];
  let acc1 = 0;
  let acc2 = 0;
  for (let i = 1; i < times.length; i++) {
    let remaining = times[i] - times[i - 1];
    while (remaining > 1e-15) {
      const dt = Math.min(dtStep, remaining);
      applyRows(rowStart, targets, rates, exit, p, k1);
      for (let s = 0; s < n; s++) tmp[s] = p[s] + (dt / 2) * k1[s];
      applyRows(rowStart, targets, rates, exit, tmp, k2);
      for (let s = 0; s < n; s++) tmp[s] = p[s] + (dt / 2) * k2[s];
      applyRows(rowStart, targets, rates, exit, tmp, k3);
      for (let s = 0; s < n; s++) tmp[s] = p[s] + dt * k3[s];
      applyRows(rowStart, targets, rates, exit, tmp, k4);
      for (let s = 0; s < n; s++)
        p[s] += (dt / 6) * (k1[s] + 2 * k2[s] + 2 * k3[s] + k4[s]);
      let sum = 0;
      for (let s = 0; s < n; s++) sum += p[s];
      for (let s = 0; s < n; s++) p[s] /= sum;
      // accumulate the rate-term integrals (Euler on small steps)
      acc1 += dt * rateSum(rho1, p);
      acc2 += dt * rateSum(rho2, p);
      remaining -= dt;
    }
    traj.push(Array.from(p));
    int1.push(acc1);
    int2.push(acc2);
  }
  return { traj, int1, int2 };
}

// times: increasing hours, times[0] === 0.
export function lossCurves(machine, times) {
  const { traj, int1, int2 } = integrate(machine, times);
  const mode1 = traj.map((p, i) => sumLf(machine.lostFraction, p) + int1[i]);
  const mode2 = traj.map(
    (p, i) => sumLf(machine.lostFraction2 ?? machine.lostFraction, p) + int2[i],
  );
  return { mode1, mode2 };
}

export function anyLossCurve(machine, times) {
  const killed = buildKilled(machine);
  const { traj } = integrate(killed, times);
  const half = machine.nStates;
  return traj.map((p) => {
    let a = 0;
    for (let s = half; s < p.length; s++) a += p[s];
    return a;
  });
}
