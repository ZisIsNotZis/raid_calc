# Ticket: 04-core-engine

- **Status:** ready-for-agent
- **Need-review:** yes (behavior changes)

## Issue

Config schema + concat/strip strategies + CTMC solver + accounting (mode 1). Demo: CLI evaluates a config, prints E[loss](t) and P(any loss)(t).

## Acceptance criteria

AC: schema validated; solver vs closed-form cases (single disk, RAID1, RAID5 first-order) within tolerance; monotone curves; composition exact (product space, symmetry collapse); unit tests.

Design refs: docs/design/raid-calc.md, optimizer.md, ui.md, architecture.md; slice plan in ../spec.md.

## Comments

- 2026-02-05 agent (pi, terra/sol): created from impl plan round.
