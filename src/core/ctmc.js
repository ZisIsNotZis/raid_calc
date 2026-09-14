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

// Numerically-stable uniformization (randomization) — the standard transient solver for CTMCs:
//   p(t) = Σ_k π_k(qt) · P^k p0,   π_k(x) = e^{-x} x^k / k!,  P = I + Q/q  (q = max exit rate)
// exact to the truncation of the Poisson sum (we stop when the tail at t_max < tol), with ONE
// sparse matvec per epoch instead of RK4's four-per-step plus renormalisation, and no stability
// limit — the epoch count is q·t_max, set by the fastest transition (repair ~1/h) rather than by
// 0.5/maxRate × horizon. The rate-term integrals use the prefix identity
//   ∫₀ᵗ Σ_s ρ(s) p(s,u) du = (1/q) Σ_{k≥1} π_k(qt) · R_k,   R_k = Σ_{j<k} (v_j·ρ)
// so everything is a single pass over epochs with a running scalar prefix.
// Weights are maintained unscaled-with-per-output-rescale, because at realistic q·t ≈ 10^4 the
// plain e^{-qt}(qt)^k/k! recursion underflows to zero long before the mode.
function uniformize(machine, times, { tol = 1e-12, kCap = 2_000_000 } = {}) {
  const { rowStart, targets, rates, exit, maxRate } = buildRows(machine);
  const n = machine.nStates;
  const q = maxRate;
  const invQ = q > 0 ? 1 / q : 0;
  const lf = machine.lostFraction;
  const lf2 = machine.lostFraction2 ?? machine.lostFraction;
  const rho1 = machine.lossRate1;
  const rho2 = machine.lossRate2;
  const nt = times.length;
  const tMax = times[nt - 1] || 0;

  const v = new Float64Array(n);
  v[machine.initialState ?? 0] = 1;
  const tmp = new Float64Array(n);
  const dot = (w) => {
    let e = 0;
    for (let i = 0; i < n; i++) e += v[i] * w[i];
    return e;
  };

  // epochs needed for the Poisson tail at t_max to fall below tol (Chernoff bound)
  const qt = q * tMax;
  const K =
    q > 0 ? Math.min(kCap, Math.ceil(qt + 12 * Math.sqrt(Math.max(qt, 1)) + 60)) : 0;

  // per-output accumulators (epoch k): m = unscaled weight, sumW = Σ_k m_k, acc = Σ m_k·(v_k·lf),
  // I1/I2 = Σ m_k·R_k/q (the rate-term integrals)
  const m = new Float64Array(nt).fill(1);
  const sumW = new Float64Array(nt);
  const acc = new Float64Array(nt);
  const acc2 = new Float64Array(nt);
  const I1 = new Float64Array(nt);
  const I2 = new Float64Array(nt);

  let rLf = dot(lf);
  let rLf2 = dot(lf2);
  let r1 = rho1 ? dot(rho1) : 0;
  let r2 = rho2 ? dot(rho2) : 0;
  let R1 = 0;
  let R2 = 0;

  for (let k = 0; k <= K; k++) {
    if (k > 0)
      for (let i = 0; i < nt; i++) m[i] *= (q * times[i]) / k;
    for (let i = 0; i < nt; i++) {
      // keep weights and accumulators in double range: a common factor cancels in acc/sumW
      if (m[i] > 1e100) {
        const f = 1e-100;
        m[i] *= f;
        sumW[i] *= f;
        acc[i] *= f;
        acc2[i] *= f;
        I1[i] *= f;
        I2[i] *= f;
      }
      sumW[i] += m[i];
      acc[i] += m[i] * rLf;
      acc2[i] += m[i] * rLf2;
      if (k > 0) {
        I1[i] += invQ * m[i] * R1;
        I2[i] += invQ * m[i] * R2;
      }
    }
    R1 += r1;
    R2 += r2;
    if (k === K) break;
    // v ← P·v. Q acts in the column convention (applyRows pushes rate_i→j from i to j), so
    // P = I + Q/q is COLUMN-stochastic: the matvec must scatter from each source state — a gather
    // form would apply Pᵀ and break the probability mass (Σv drifts).
    for (let i = 0; i < n; i++)
      tmp[i] = q > 0 ? (1 - exit[i] * invQ) * v[i] : v[i];
    for (let i = 0; i < n; i++) {
      const vi = v[i];
      if (vi !== 0) {
        const f = vi * invQ;
        const e = rowStart[i + 1];
        for (let j = rowStart[i]; j < e; j++) tmp[targets[j]] += rates[j] * f;
      }
    }
    v.set(tmp);
    // next epoch's functionals: from the NEW v (a dot taken from the old v during the scatter
    // would land one epoch behind and lose the stationary repair-mass contribution)
    let nLf = 0;
    let nLf2 = 0;
    let nR1 = 0;
    let nR2 = 0;
    for (let i = 0; i < n; i++) {
      const vi = v[i];
      nLf += vi * lf[i];
      nLf2 += vi * lf2[i];
      if (rho1) nR1 += vi * rho1[i];
      if (rho2) nR2 += vi * rho2[i];
    }
    rLf = nLf;
    rLf2 = nLf2;
    r1 = nR1;
    r2 = nR2;
  }

  // acc and I1 carry the same missing factors as sumW (the e^{-qt} and the rescales), so dividing
  // by sumW renormalises both at once
  // plain Array (not Float64Array): renderChart's flatMap assumes regular arrays, and the RK4 path
  // also returns Arrays — keeping the type contract lets the two methods be drop-in interchangeable
  const mode1 = Array.from(acc, (x, i) => (sumW[i] > 0 ? x / sumW[i] : 0) + I1[i] / (sumW[i] || 1));
  const mode2 = Array.from(acc2, (x, i) => (sumW[i] > 0 ? x / sumW[i] : 0) + I2[i] / (sumW[i] || 1));
  return { mode1, mode2 };
}

// times: increasing hours, times[0] === 0.
export function lossCurves(machine, times, { method = "uniform" } = {}) {
  if (method === "rk4") {
    const { traj, int1, int2 } = integrate(machine, times);
    return {
      mode1: traj.map((p, i) => sumLf(machine.lostFraction, p) + int1[i]),
      mode2: traj.map(
        (p, i) => sumLf(machine.lostFraction2 ?? machine.lostFraction, p) + int2[i],
      ),
    };
  }
  return uniformize(machine, times);
}

export function anyLossCurve(machine, times, { method = "uniform" } = {}) {
  const killed = buildKilled(machine);
  if (method === "rk4") {
    const { traj } = integrate(killed, times);
    const half = machine.nStates;
    return traj.map((p) => {
      let s = 0;
      for (let i = half; i < p.length; i++) s += p[i];
      return s;
    });
  }
  // P(any loss)(t) = mass that has crossed into the killed chain's absorbing half — the
  // half-indicator, not machine.lostFraction (which also marks first-half lost-data states)
  const half = machine.nStates;
  const lfLost = new Float64Array(killed.nStates);
  for (let s = half; s < killed.nStates; s++) lfLost[s] = 1;
  const { mode1 } = uniformize({ ...killed, lostFraction: lfLost }, times);
  return mode1;
}
