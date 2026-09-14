# Architecture — Design

Status: v1 (2026-02-05). Companion to `raid-calc.md` (model), `optimizer.md`, `ui.md`.

## 1. Deliverable & build

- Source: ES modules under `src/core/` and `src/ui/`; build via esbuild into a single committed `raid-calc.html` (inline JS + CSS). Opens via `file://`, fully offline, no server, no runtime dependencies.
- `src/` is authored; the built HTML is committed so the artifact is always directly usable. Build script: `npm run build` (esbuild as the only dev dependency).

## 2. Threading

- Everything runs on the main thread: UI, chart rendering, `evaluate()`.
- No Web Worker. v1 claimed an inline Blob worker for Monte Carlo, optimizer sweeps, and previews;
one was ever built, and the single-file bundle plus the collapsed repair-chain speedup make it
unnecessary: a full 5-year horizon runs in seconds, per-node previews use a reduced point count and
state budget, and oversized state spaces fail fast with `BuildError` instead of freezing. If a future
feature reintroduces a blocking sweep (large MC batches, wide optimizer searches), the worker lands
with that feature — not before. `ui.md §5` records the same decision from the UI side.

## 3. Config JSON — the contract

One schema is the SSOT for UI, engine, optimizer, and saved files:

```json
{
  "schemaVersion": 1,
  "kinds":   [{ "id": "hdd8", "capacityTB": 8, "lambdaBase": 2.8e-6, "lambdaRead": 0.9e-12, "lambdaWrite": 1.4e-12, "ure": 7.9e-15, "readBW": 190e6, "writeBW": 170e6, "count": 12, "spares": 1 }],
  "tree":    { "node": "pool", "strategy": "split", "n": 2, "m": 1, "lambdaCC": 1e-7,
               "members": [ { "node": "pool", "strategy": "strip", "d": 3, "m": 1, "lambdaCC": 1e-7, "members": [{ "node": "kind", "kind": "hdd8", "count": 4 }] } ] },
  "global":  { "tOpH": 12, "tSwapH": 0.167, "tProcH": 48, "rebuildBw": 150e6, "contention": true },
  "workload": { "storeTB": 40, "readBps": 200e6, "writeBps": 50e6, "avgFileMB": 8, "horizonY": 5 },
  "ui":      { "pos": {}, "collapsed": {}, "view": { "x": 60, "y": 24, "zoom": 1 } }
}
```

- `ui` is view state (free card positions, collapsed subtrees, pan/zoom). `validate()` ignores unknown
top-level keys, so it needs no schema bump and round-trips through Export/Import for free; the solver
never reads it. It is written by the canvas and never by the engine.

- Units are hard-coded SI-ish: times in hours (`tOpH/tSwapH/tProcH`), rates per hour, IO in bytes/s, capacities in TB (decimal). `rebuildBw` is used when `contention: false` (dedicated rebuild bandwidth); with contention on it is ignored. Usage ratio is **derived**: `u = storeTB ÷ usable` — `storeTB` is the SSOT input. `schemaVersion` gates localStorage/import round-trips. `lambdaCC` is per pool (leaf-pool shocks; parent-level λcc is rejected at build).
- **Inventory validation rule**: Σ disks referenced by the tree per kind + that kind's `spares` ≤ `count` — hand-built configs are rejected at validation, same as optimizer output.

- Engine is pure: `evaluate(config) → curves + per-node previews`. No engine state outside the config; UI/optimizer only produce configs.
- Identifiers: kind `id` is the one name everywhere (Design 5: no redundant type fields beyond the structural `node` discriminator).

## 4. Modules

`src/core/`: `config.js` (schema, validation, normalization, `validate`) · `strategies/index.js`
(strategy definitions: member count, usable factor, placement/IO fanout) · `machine.js` (pool machine
construction, repair-chain collapsing, spare clusters, `BuildError`, state budget) · `ctmc.js`
(transient solver: **uniformization** by default — Poisson-weighted embedded chain, exact to 1e-12 and
~3-4× faster than the retained RK4 (`method: "rk4"`, kept as the fine-step reference) — `lossCurves`,
`anyLossCurve`) · `evaluate.js` (top-level config → curves; the only entry point) · `mc.js` (Gillespie
cross-check) · `optimizer.js` (greedy + local search, feasibility gates, top-3) · `errors.js` (shared
error types).

`src/ui/`: `app.js` (state store over config JSON, undo stack, file import/export) · `canvas.js` (pure
node model: paths, tree ops, drag-legality predicates — plus the DOM renderer: cards, wires, viewport,
gestures, minimap) · `positions.js` (free positions + their survival across structural edits, viewport
maths) · `layout.js` (variable-height tidy-tree layout) · `props.js` (context forms: pool, disk model,
scenario) · `results.js` (run/preview evaluation, summaries, formatting) · `charts.js` (hand-rolled SVG
curves — few series, zero deps) · `commands.js` (command palette, shortcut sheet, confirm dialog) ·
`main.js` (wiring: header, sidebar, results drawer, optimizer modal, keyboard).

## 5. Testing

- Node-based unit tests (vitest, dev-only): each strategy's placement/loss-weights against hand-computed worked examples (the D2 worked examples); CTMC solver vs closed-form cases (single disk, RAID1 mirror, RAID5 MTTDL first-order); accounting monotonicity; MC vs analytic agreement gate (the §3.8 semantics identity).
- Smoke: `npm run smoke` drives the built `raid-calc.html` in a real browser (`scripts/ux-smoke.mjs`,
Playwright) with real pointer gestures — card drag, re-parent, link create/cut, library drop, zoom,
palette — and writes screenshots to `.scratch/01-raid-calc/evidence/`. It fails on any console or page
error. Also `npm run build` output loads offline, evaluates the sample config, and renders curves
(covered by the same smoke).

## 6. Constraints honored

- Exactness discipline of raid-calc.md §3.3 (no mean-field) and §3.8 (MC validates solver only) are structural: `compose.js` has no approximation entry points.
- Everything deterministic except MC; inputs are user-facing units, converted **once** at validation to SI base units — the engine and its time grid never re-convert or rescale.
