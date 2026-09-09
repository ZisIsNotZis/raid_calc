# Spec: raid calculator

Single-file HTML tool computing mathematical expectation of data loss vs time for hierarchical storage pools.

Design truth (supreme):

- Model: `docs/design/raid-calc.md` — disks, strategies, CTMC composition, rebuild/contention, spares, accounting, solver.
- Optimizer: `docs/design/optimizer.md` — constraints, feasibility gates, search, output.
- UI: `docs/design/ui.md` — node canvas, panels, charts (sketch: `.scratch/01-raid-calc/ui-sketch.html`).
- Architecture: `docs/design/architecture.md` — build, worker, config JSON schema, modules, tests.

Implementation slices (tracer-bullet order, one ticket each in `issues/`):

1. `04-core-schema-strategies` — config schema + concat/strip strategy functions + worked-example tests.
2. `05-ctmc-solver` — solver + composition + accounting (mode 1) + closed-form validation.
3. `06-split-strategy` — split(N,M) (strip-split deferred pending D4).
4. `07-io-feasibility` — bandwidth, amplification, contention, effective T_rebuild, slowdown factor.
5. `08-spare-clusters` — global per-kind spares, joint clusters, state-space budget.
6. `09-mc-crosscheck` — MC simulator + solver-agreement gate.
7. `10-optimizer` — enumeration/greedy, gates, top-3 output.
8. `11-ui-canvas` — node graph editor, props panel, config round-trip (parallelizable after 04).
9. `12-ui-results` — output node, charts, comparison overlay, optimize modal wiring.
10. `13-build-bundle` — esbuild single-file artifact, README quickstart.

Open: D4 (mode 2 / strip-split scope) — user-gated; blocked slices would attach here.
