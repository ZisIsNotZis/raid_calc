# Ticket: 07-io-feasibility

- **Status:** claimed
- **Need-review:** yes (behavior changes)

## Issue

Bandwidth wiring: workload fan-out, read/write amplification via composed path maps, rebuild contention (leftover bandwidth, cross-level per-disk budget), effective T_rebuild, contention toggle, slowdown factor.

## Acceptance criteria

AC: feasibility check per-disk; concat pair-limited rebuild; proportional-slowdown budget test; contention on/off both paths tested.

Design refs: docs/design/raid-calc.md, optimizer.md, ui.md, architecture.md; slice plan in ../spec.md.

## Comments

- 2026-02-05 agent (pi, terra/sol): created from reviewed impl plan (v2 re-slice: 04 split into 04+05 per review sizing advice; UI canvas parallelizable; chain renumbered).
