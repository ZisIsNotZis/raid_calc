# Ticket: 10-optimizer

- **Status:** ready-for-agent
- **Need-review:** yes (behavior changes)

## Issue

Enumeration (partitions × strategies × depth ≤2, mirrors as strip(1,1)) + caps + greedy/local-search fallback + budget-degradation policy; feasibility gates; objective dropdown; top-3 + curve overlay; apply-to-canvas emission.

## Acceptance criteria

AC: deterministic lexicographic tie-break; gates reject over-capacity/over-bandwidth; reference example (12×8TB → 3×strip(3,1) → split(2,1), store 40TB) feasible and top-ranked.

Design refs: docs/design/raid-calc.md, optimizer.md, ui.md, architecture.md; slice plan in ../spec.md.

## Comments

- 2026-02-05 agent (pi, terra/sol): created from reviewed impl plan (v2 re-slice: 04 split into 04+05 per review sizing advice; UI canvas parallelizable; chain renumbered).
