# Architecture — Design

Status: v1 (2026-02-05). Companion to `raid-calc.md` (model), `optimizer.md`, `ui.md`.

## 1. Deliverable & build

- Source: ES modules under `src/core/` and `src/ui/`; build via esbuild into a single committed `raid-calc.html` (inline JS + CSS). Opens via `file://`, fully offline, no server, no runtime dependencies.
- `src/` is authored; the built HTML is committed so the artifact is always directly usable. Build script: `npm run build` (esbuild as the only dev dependency).

## 2. Threading

- Main thread: UI, chart rendering.
- Inline Web Worker (created from a Blob URL so the bundle stays single-file): **everything expensive follows the cost, not the feature name** — Monte Carlo runs, optimizer sweeps, and per-node preview evaluations. Worker receives the config JSON, returns curves/results; progress messages for long sweeps; previews debounced client-side.

## 3. Config JSON — the contract

One schema is the SSOT for UI, engine, optimizer, and saved files:

```json
{
  "schemaVersion": 1,
  "kinds":   [{ "id": "hdd8", "capacityTB": 8, "lambdaBase": 2.8e-6, "lambdaRead": 0.9e-12, "lambdaWrite": 1.4e-12, "ure": 7.9e-15, "readBW": 190e6, "writeBW": 170e6, "count": 12, "spares": 1 }],
  "tree":    { "node": "pool", "strategy": "split", "n": 2, "m": 1, "lambdaCC": 1e-7,
               "members": [ { "node": "pool", "strategy": "strip", "d": 3, "m": 1, "lambdaCC": 1e-7, "members": [{ "node": "kind", "kind": "hdd8", "count": 4 }] } ] },
  "global":  { "topSec": 12, "swapSec": 600, "procSec": 172800, "timeUnit": "h", "contention": true, "rebuildBw": 150e6, "lambdaCCDefault": 1e-7 },
  "workload": { "storeTB": 40, "readBps": 200e6, "writeBps": 50e6, "avgFileMB": 8, "horizonY": 5 }
}
```

- `rebuildBw` is used when `contention: false` (dedicated rebuild bandwidth); with contention on it is ignored. `lambdaCCDefault` pre-fills new pool nodes. Usage ratio is **derived**: `u = storeTB ÷ usable` — `storeTB` is the SSOT input. `schemaVersion` gates localStorage/import round-trips.
- **Inventory validation rule**: Σ disks referenced by the tree per kind + that kind's `spares` ≤ `count` — hand-built configs are rejected at validation, same as optimizer output.

- Engine is pure: `evaluate(config) → curves + per-node previews`. No engine state outside the config; UI/optimizer only produce configs.
- Identifiers: kind `id` is the one name everywhere (Design 5: no redundant type fields beyond the structural `node` discriminator).

## 4. Modules

`src/core/`: `config.js` (schema, validation, defaults) · `strategies/` (one file per strategy exporting placement / ioFanout / readPathMap / lossWeights) · `compose.js` (bottom-up product-space composition, symmetry collapse, spare-sharing clusters) · `ctmc.js` (uniformization / ODE solver) · `accounting.js` (E[loss] integration, killed-CTMC P(any loss)) · `feasibility.js` (capacity, bandwidth incl. amplification + contention, assignment) · `rebuild.js` (T_rebuild computation) · `optimizer.js` (enumerate/greedy, gates, ranking) · `mc.js` (discrete-event simulator) · `previews.js` (per-node standalone evaluation).

`src/ui/`: `app.js` (state store over config JSON, undo stack) · `canvas.js` (SVG node graph, tidy-tree layout, typed ports) · `props.js` (forms) · `charts.js` (hand-rolled SVG curves — few series, zero deps) · `optimizePanel.js` · `persist.js` (localStorage + file import/export).

## 5. Testing

- Node-based unit tests (vitest, dev-only): each strategy's placement/loss-weights against hand-computed worked examples (the D2 worked examples); CTMC solver vs closed-form cases (single disk, RAID1 mirror, RAID5 MTTDL first-order); accounting monotonicity; MC vs analytic agreement gate (the §3.8 semantics identity).
- Smoke: built HTML loads offline, evaluates the sketch's example config, renders curves.

## 6. Constraints honored

- Exactness discipline of raid-calc.md §3.3 (no mean-field) and §3.8 (MC validates solver only) are structural: `compose.js` has no approximation entry points.
- Everything deterministic except MC; inputs are user-facing units, converted **once** at validation to SI base units — the engine and its time grid never re-convert or rescale.
