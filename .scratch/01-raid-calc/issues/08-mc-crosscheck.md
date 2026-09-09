# Ticket: 08-mc-crosscheck

- **Status:** ready-for-agent
- **Need-review:** yes (behavior changes)
- **Blocked by:** previous slice

## Issue

Discrete-event MC (worker-ready) implementing identical semantics; agreement gate vs analytic within MC noise.

## Acceptance criteria

AC: agreement test on ≥3 configs (mirror, RAID5, split); discrepancies diagnosable (per-state counts).

Design refs: docs/design/raid-calc.md, optimizer.md, ui.md, architecture.md; slice plan in ../spec.md.

## Comments

- 2026-02-05 agent (pi, terra/sol): created from impl plan round.
