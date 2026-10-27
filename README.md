**English** | [简体中文](README.zh-CN.md)

<p align="center">
  <img src="docs/logo.svg" width="104" height="104" alt="raid_calc logo">
</p>

<h1 align="center">raid_calc</h1>

<p align="center"><strong>Know how much data your storage pool is expected to lose — not just whether RAID is “safe”.</strong></p>

<p align="center">A single-file, offline browser calculator that composes disks into arbitrarily nested pools and computes the mathematical expectation of data loss over time with exact CTMC numerics.</p>

<p align="center">
  <a href="raid-calc.html">App file</a> · <a href="LICENSE">MIT license</a> · <a href="CONTRIBUTING.md">Contributing</a>
</p>

![raid_calc editor with nested pools and expected-loss curves](docs/screenshot.png)

*The editor builds a tree of pools; the results drawer plots the top-level `E[lost](t)` and `P(any loss)(t)` curves.*

## Quick start

Clone the repo and open [`raid-calc.html`](raid-calc.html) in a modern browser. That is the whole install: no server, no network, no build step, fully offline.

```bash
git clone https://github.com/ZisIsNotZis/raid_calc.git
cd raid_calc
open raid-calc.html      # macOS; xdg-open raid-calc.html on Linux, or just double-click the file
```

The committed HTML is generated from [`src/`](src/) and always runs straight from disk. To rebuild it after a source change:

```bash
npm install
npm run build
```

## What it can do now

- **Compose real storage trees.** `concat`, `strip(D,M)`, `split(N,M)`, and `strip-split(N,M)` pools nest to any depth; every pool exposes one logical disk to its parent.
- **Get expectation, not a single MTTF number.** A continuous-time Markov chain (CTMC) is solved by uniformization to 1e-12, producing `E[lost bytes](t)` and `P(any loss)(t)` across the time horizon. Monte Carlo is included as a cross-check, never as the headline answer.
- **Model the failures that actually dominate.** Computed rebuild times under workload bandwidth contention, URE hazard on bulk rebuild reads, common-cause shocks, global per-disk spare inventory, operator and procurement waits.
- **Choose the accounting rule.** *Rigorous* counts any corruption as a lost file; *partial* counts only the chunks beyond parity, modelling degraded-but-usable data.
- **Edit visually.** Drag pool cards to re-parent them, drag disks from the library, rewire links, collapse subtrees, and inspect per-pool loss curves. Undo/redo, command palette (`Ctrl+K`), shortcuts (`?`), import/export JSON, English/中文, and light/dark themes are built in.
- **Search the design space.** Auto-optimize runs greedy plus local search under capacity, per-disk bandwidth, and spare-inventory gates, then paints the winning config onto the canvas and shows the top three.
- **Stay portable.** One HTML file, one JSON config. No backend, no telemetry, no runtime dependencies.

## Architecture

The engine is pure and the UI is the only side-effecting layer. The build inlines both into the single-file artifact.

```text
src/core/      pure model + CTMC engine: config, strategies, machine, ctmc,
               evaluate, Monte Carlo, optimizer, errors
src/ui/        editor, canvas, properties, charts, results, i18n, commands
scripts/       build.mjs, Playwright smoke, solver benchmark
demo/          small CLI example that prints curves
tests/         vitest: closed-form checks, composition identities, MC agreement, UI logic
docs/design/   model, optimizer, UI, and architecture decisions
index.html     development shell; build.mjs inlines src/ into raid-calc.html
```

A single config JSON is the source of truth for the canvas, engine, optimizer, and saved files. The engine reads that config and returns curves plus per-node previews; the UI and optimizer only produce configs.

Read the full design: [model](docs/design/raid-calc.md) · [optimizer](docs/design/optimizer.md) · [UI](docs/design/ui.md) · [architecture](docs/design/architecture.md).

## How to develop

Requires Node.js and npm.

```bash
npm test             # vitest: closed-form validations, composition identities, MC agreement, UI logic
npm run demo         # CLI: evaluate two configs and print curve samples
npm run build        # esbuild -> raid-calc.html (committed artifact)
npm run smoke        # Playwright: drive the built app with real pointer gestures
node scripts/bench-solver.mjs   # solver speed evidence
```

`src/core` stays free of DOM and globals. Numerics changes must keep the closed-form tests green; UI behavior changes get a Playwright check in `scripts/ux-smoke.mjs`.

## How to contribute

Start with [CONTRIBUTING.md](CONTRIBUTING.md). In short: describe the problem and acceptance criteria, keep `npm test` green, rebuild the committed artifact when source changes, and attach evidence for UI or numerics changes.

## Roadmap

### Implemented (v1)

- [x] Exact CTMC engine with uniformization, `lossCurves`, and `anyLossCurve`; RK4 retained as a reference method.
- [x] Nested `concat` / `strip` / `split` / `strip-split` composition with exact state accounting.
- [x] Rebuild contention, URE hazard, common-cause shocks, spare-sharing clusters, and repair delays.
- [x] Rigorous and partial loss accounting modes.
- [x] Direct-manipulation canvas, per-pool previews, results drawer, undo/redo, command palette, i18n, themes.
- [x] Deterministic auto-optimizer with feasibility gates and top-3 output.
- [x] Monte Carlo cross-check, vitest suite, and real-browser smoke evidence.
- [x] Single-file offline artifact and the v1 design docs.

### Planned

No release is scheduled: v1 is closed. If the project is picked up again, the natural next steps are the explicit v1 non-goals — IOPS/latency and queueing, scrubbing and latent-error accumulation, aging curves, and operator error — plus larger state spaces and a file-size distribution instead of the average-file approximation.

The long-term shape is a calculator you can trust like a spreadsheet: build any hierarchy you can actually operate, see the expected loss curve immediately, and let the optimizer explain the trade-off it chose. The solver stays exact where it can be exact, and every approximation is labelled in the UI and the design docs.

Known limit: very large machines (over roughly 100k states) at multi-year horizons are still expensive. They fail fast with a `BuildError` instead of hanging; the optimizer caps each candidate at 20,000 states and reports what it skipped.

## License

[MIT](LICENSE)
