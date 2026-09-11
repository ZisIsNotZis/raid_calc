// Hand-rolled SVG line charts — zero dependencies (architecture.md §4).
// Pure path/scale helpers (unit-tested in tests/ui.test.js) + DOM renderer.

import { TB } from "../core/config.js";

// --- scales (pure) -------------------------------------------------------------

export function linearScale(domain, range) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  return (v) => r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);
}

// Log-y scale: domain must be > 0. Returns fn mapping v -> pixel y.
export function logScale(domain, range) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const l0 = Math.log10(d0);
  const l1 = Math.log10(d1);
  // clamp non-positive values (loss = 0 early in the horizon) to the domain floor
  return (v) =>
    r0 + ((Math.log10(Math.max(v, d0)) - l0) / (l1 - l0)) * (r1 - r0);
}

// SVG path from points [[x,y],...]; straight segments.
export function linePath(points) {
  if (points.length === 0) return "";
  const [first, ...rest] = points;
  let d = `M ${fmt(first[0])} ${fmt(first[1])}`;
  for (const p of rest) d += ` L ${fmt(p[0])} ${fmt(p[1])}`;
  return d;
}

// Sample the series at the pixel grid, mapping values to pixels. Returns [[px,py],...].
// series: { x: number[], y: number[] } (x = hours, y = values)
export function projectToPixels(
  series,
  { width, height, xDomain, yScale, pad = 2 },
) {
  const x = linearScale(xDomain, [pad, width - pad]);
  const pts = [];
  for (let i = 0; i < series.x.length; i++) {
    const v = series.y[i];
    if (!Number.isFinite(v)) continue;
    let py;
    try {
      py = yScale(v);
    } catch {
      continue;
    }
    pts.push([x(series.x[i]), py]);
  }
  return pts;
}

// Nice tick values for a log-y axis: 1e^a..1e^b at one value per decade (10^e).
export function logTicks(domain) {
  const [d0, d1] = domain;
  const l0 = Math.ceil(Math.log10(d0));
  const l1 = Math.floor(Math.log10(d1));
  const ticks = [];
  for (let e = l0; e <= l1; e++) {
    const v = 10 ** e;
    if (v >= d0 && v <= d1) ticks.push(v);
  }
  return ticks;
}

function fmt(n) {
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? String(r) : String(r);
}

// --- DOM renderer --------------------------------------------------------------

// Render series (array of { label, points, color, dashed }) into an svg element.
export function renderChart(
  svg,
  { width, height, series, xLabel, yLabel, logY = true },
) {
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = "";
  const pad = 8;
  const plotW = width - pad * 2;
  const plotH = height - pad * 2;
  const yMax = series
    .flatMap((s) => (s.y ? s.y : s.points.map((p) => p[1])))
    .reduce((a, b) => Math.max(a, b), 1);
  const yDomain = logY
    ? [Math.max(1e-3, yMax / 1e4), Math.max(yMax, 1)]
    : [0, Math.max(yMax, 1e-6)];
  const yScale = logY
    ? logScale(yDomain, [pad + plotH, pad])
    : linearScale(yDomain, [pad + plotH, pad]);
  const xDomain = [0, series[0] && series[0].x ? series[0].x[series[0].x.length - 1] : 1];

  // grid + axes
  for (const ty of logY ? logTicks(yDomain) : [0, yDomain[1] / 2, yDomain[1]]) {
    const y = yScale(ty);
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", pad);
    line.setAttribute("y1", y);
    line.setAttribute("x2", pad + plotW);
    line.setAttribute("y2", y);
    line.setAttribute("stroke", "var(--line)");
    svg.appendChild(line);
    const label = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "text",
    );
    label.setAttribute("x", pad - 2);
    label.setAttribute("y", y + 3);
    label.setAttribute("text-anchor", "end");
    label.setAttribute("font-size", "8");
    label.setAttribute("fill", "var(--muted)");
    label.textContent = logY ? scientific(ty) : fmt(ty);
    svg.appendChild(label);
  }
  for (const s of series) {
    const pts = projectToPixels(
      { x: s.x, y: s.y },
      { width, height, xDomain, yScale, pad: 4 },
    );
    s.points = pts;
    s.xMax = s.x[s.x.length - 1] || 1;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", linePath(pts));
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", s.color);
    path.setAttribute("stroke-width", "2");
    if (s.dashed) path.setAttribute("stroke-dasharray", "4 3");
    svg.appendChild(path);
  }
  if (xLabel) {
    const tx = document.createElementNS("http://www.w3.org/2000/svg", "text");
    tx.setAttribute("x", pad + plotW);
    tx.setAttribute("y", height - 1);
    tx.setAttribute("text-anchor", "end");
    tx.setAttribute("font-size", "8");
    tx.setAttribute("fill", "var(--muted)");
    tx.textContent = xLabel;
    svg.appendChild(tx);
  }
  if (yLabel) {
    const ty = document.createElementNS("http://www.w3.org/2000/svg", "text");
    ty.setAttribute("x", pad);
    ty.setAttribute("y", 6);
    ty.setAttribute("font-size", "8");
    ty.setAttribute("fill", "var(--muted)");
    ty.textContent = yLabel;
    svg.appendChild(ty);
  }
}

function scientific(v) {
  if (v === 0) return "0";
  const e = Math.floor(Math.log10(v));
  const m = v / 10 ** e;
  return `${m.toFixed(m >= 10 ? 0 : 1)}e${e}`;
}

// Build chart series from an evaluate() result.
export function evaluateSeries(result, { mode = 1, bytes = true } = {}) {
  const y = bytes
    ? mode === 1
      ? result.expectedLostBytes
      : result.expectedLostBytesPartial
    : mode === 1
      ? result.expectedLostFraction
      : result.expectedLostFractionPartial;
  return { x: result.times, y };
}

// Human-readable byte count (TB scale).
export function fmtBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  const t = bytes / TB;
  if (t >= 1) return `${t.toFixed(2)} TB`;
  return `${(bytes / 1e6).toFixed(1)} MB`;
}
