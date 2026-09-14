# AGENTS.md — working guide for this repo

Product and design truth lives in `docs/` (see `docs/design/`) and overrides everything here.
Tickets live in `.scratch/01-raid-calc/issues/` with physical-file status
(`needs-triage → ready-for-human → ready-for-agent → claimed → done`).

## What this is

A single-file, offline, browser-based calculator for the mathematical expectation of data loss over
time in hierarchical storage pools (RAID-like). The engine is exact CTMC numerics; Monte Carlo is a
cross-check, never the headline number.

## Commands

```bash
npm install          # dev tooling: esbuild, vitest, playwright
npm run build        # bundle src/ into raid-calc.html (the committed artifact)
npm test             # vitest — closed-form validations, composition identities, MC agreement, UI logic
npm run smoke        # playwright: drives the built artifact with real pointer gestures
npm run demo         # CLI demo (node demo/demo.js)
node scripts/bench-solver.mjs   # before/after solver speed evidence
```

## Conventions

- Engine purity: `src/core/*` is pure functions over the config JSON; no DOM, no globals. The UI
  (`src/ui/*`) is the only side-effecting layer. Keep it that way.
- The solver's primary method is **uniformization** (`ctmc.js`, default). The old RK4 remains
  available as `lossCurves(machine, times, { method: "rk4" })` and is the reference the closed-form
  tests exercise against; any numerics change must keep `npm test` green.
- UI config is the single source of truth: canvas, props, optimizer all read/write the same JSON
  schema in `architecture.md §3`. Commit structural edits through the immutable `store.set` path.
- Numbers carry units: bytes and hours internally; TB/years only at the edge (`config.js`).
- Evidence over claims: behavior changes get a Playwright check in `scripts/ux-smoke.mjs`; numerics
  get a vitest test; speed changes get a `scripts/bench-solver.mjs` number.
- Do not commit secrets, credentials, or machine-local harness state (`.pi-glla/` is ignored).

## Review bar

Structural/solver/numerics changes go through a fresh-context adversarial review (diff + spec +
"find what breaks"; preset verdicts, not approval) before merge. The smoke suite and the closed-form
tests are that review's evidence.
