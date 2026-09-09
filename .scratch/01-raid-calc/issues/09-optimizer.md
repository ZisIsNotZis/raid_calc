# Ticket: 09-optimizer

- **Status:** ready-for-agent
- **Need-review:** yes (behavior changes)
- **Blocked by:** previous slice

## Issue

Enumeration (partitions × strategies × depth ≤2) + caps + greedy/local-search fallback; feasibility gates; objective dropdown; top-3 + curve overlay; apply-to-canvas config emission.

## Acceptance criteria

AC: deterministic ranking (lexicographic tie-break); gates reject over-capacity/over-bandwidth; sketch example config found.

Design refs: docs/design/raid-calc.md, optimizer.md, ui.md, architecture.md; slice plan in ../spec.md.

## Comments

- 2026-02-05 agent (pi, terra/sol): created from impl plan round.
