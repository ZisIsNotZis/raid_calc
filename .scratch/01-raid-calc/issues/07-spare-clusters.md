# Ticket: 07-spare-clusters

- **Status:** ready-for-agent
- **Need-review:** yes (behavior changes)
- **Blocked by:** previous slice

## Issue

Global per-kind spare inventory; pools sharing a kind solved as joint cluster (shared spare-count dimension); procurement path on depletion.

## Acceptance criteria

AC: shock consuming > stocked spares triggers T_proc; cluster solve matches hand-built joint model on 2-pool example.

Design refs: docs/design/raid-calc.md, optimizer.md, ui.md, architecture.md; slice plan in ../spec.md.

## Comments

- 2026-02-05 agent (pi, terra/sol): created from impl plan round.
