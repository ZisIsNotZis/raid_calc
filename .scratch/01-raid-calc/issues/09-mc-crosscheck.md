# Ticket: 09-mc-crosscheck

- **Status:** claimed
- **Need-review:** yes (behavior changes)

## Issue

Discrete-event MC (worker-ready) implementing identical semantics; agreement gate vs analytic within MC noise.

## Acceptance criteria

AC: agreement on ≥3 configs (mirror, RAID5, split); discrepancies diagnosable via per-state counts.

Design refs: docs/design/raid-calc.md, optimizer.md, ui.md, architecture.md; slice plan in ../spec.md.

## Comments

- 2026-02-05 agent (pi, terra/sol): created from reviewed impl plan (v2 re-slice: 04 split into 04+05 per review sizing advice; UI canvas parallelizable; chain renumbered).
