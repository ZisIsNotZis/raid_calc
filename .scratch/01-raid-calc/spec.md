# Spec: raid calculator

Single-file HTML tool computing mathematical expectation of data loss vs time for hierarchical storage pools.

Design truth (supreme):

- Model: `docs/design/raid-calc.md` — disks, strategies, CTMC composition, rebuild/contention, spares, accounting, solver.
- Optimizer: `docs/design/optimizer.md` — constraints, feasibility gates, search, output.
- UI: `docs/design/ui.md` — node canvas, panels, charts (sketch: `.scratch/01-raid-calc/ui-sketch.html`).
- Architecture: `docs/design/architecture.md` — build, worker, config JSON schema, modules, tests.

Implementation slices (tracer-bullet order, one ticket each in `issues/`):

1. `04-core-engine` — config schema + concat/strip + CTMC solver + accounting (mode 1). Demoable: CLI evaluates a config, prints curves.
2. `05-split-strategy` — split(N,M) placement/loss weights (strip-split deferred pending D4).
3. `06-io-feasibility` — bandwidth params, fan-out/amplification, rebuild contention, effective T_rebuild.
4. `07-spare-clusters` — global per-kind spares, spare-sharing joint clusters.
5. `08-mc-crosscheck` — MC simulator + solver-agreement gate.
6. `09-optimizer` — enumeration/greedy, gates, top-3 output.
7. `10-ui-canvas` — node graph editor, props panel, config round-trip.
8. `11-ui-results` — output node, charts, comparison overlay, optimize modal wiring.
9. `12-build-bundle` — esbuild single-file artifact, README quickstart.

Open: D4 (mode 2 / strip-split scope) — user-gated; blocked slices would attach here.
