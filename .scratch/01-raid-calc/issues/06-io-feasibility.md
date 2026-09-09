# Ticket: 06-io-feasibility

- **Status:** ready-for-agent
- **Need-review:** yes (behavior changes)
- **Blocked by:** previous slice

## Issue

Bandwidth params wired: workload fan-out, read/write amplification via composed path maps, rebuild contention (leftover bandwidth), effective T_rebuild, contention toggle.

## Acceptance criteria

AC: feasibility check per-disk; concat pair-limited rebuild; slowdown factor reported; contention on/off both paths tested.

Design refs: docs/design/raid-calc.md, optimizer.md, ui.md, architecture.md; slice plan in ../spec.md.

## Comments

- 2026-02-05 agent (pi, terra/sol): created from impl plan round.
