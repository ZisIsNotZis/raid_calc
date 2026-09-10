# Ticket: 07-io-feasibility

- **Status:** done
- **Need-review:** yes (behavior changes)

## Issue

Bandwidth wiring: workload fan-out, read/write amplification via composed path maps, rebuild contention (leftover bandwidth, cross-level per-disk budget), effective T_rebuild, contention toggle, slowdown factor.

## Acceptance criteria

AC: feasibility check per-disk; concat pair-limited rebuild; proportional-slowdown budget test; contention on/off both paths tested.

Design refs: docs/design/raid-calc.md, optimizer.md, ui.md, architecture.md; slice plan in ../spec.md.

## Comments

- 2026-02-05 agent (pi, terra/sol): created from reviewed impl plan (v2 re-slice: 04 split into 04+05 per review sizing advice; UI canvas parallelizable; chain renumbered).

## Comments (review + closure)

- 2026-02-05 agent (pi, terra/sol): implemented leftover-bandwidth rebuild (R = min(readBW − wl.read, writeBW); contention off = dedicated rebuildBw), per-disk feasibility gates (throw on wl > bw and on saturated pool), slowdown factor = T_contended/T_idle per §3.7, per-member plans in concat (pair-limited: source-read leftover ⊗ spare write), parent slowdown/utilization propagation. 33 tests green incl. contended-MTTDL closed form, feasibility boundaries, contention-off dedicated-rate regression.
- 2026-02-05 agent (pi, terra/sol): review (BLOCK) integrated — P1 parent→child workload now scaled by the parent strategy's IO share before recursing (was compounding the full top-level rate per level: false feasibility rejects + pessimistic hazard); P1 bare-disk slowdown/utilization exposed; P1 contention-off path now asserted on the actual rebuild-exit rate. Recorded deferrals: (a) concurrent rebuilders within one pool don't divide the leftover budget (optimistic, confined to O(λ²) multi-rebuild states — folds into ticket 08 with cross-level dynamics); (b) cross-level concurrent-rebuild contention lands with ticket 08 (parent-level rebuild isn't modeled as dynamics yet — no overstatement in shipped dynamics). Known conservative divergences disclosed in machine.js comments (λr elevation granularity; parity-member rebuild reads).
