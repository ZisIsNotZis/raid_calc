# Ticket: design docs round 2 (optimizer, UI, architecture) + impl plan

- **Status:** claimed
- **Need-review:** yes (design truth; fresh-context review in progress)

## Issue

Write down model updates (global per-kind spares, contention, bandwidth params), optimizer design, UI design, architecture — plus implementation plan — per user go-signal.

## Acceptance criteria

- [x] raid-calc.md → v3 (spare-sharing clusters, leftover-bandwidth contention, disk R/W bandwidth, D1 resolved)
- [x] docs/design/optimizer.md, ui.md, architecture.md authored
- [x] spec.md impl plan + tickets 04–12 created
- [ ] Fresh-context review done, findings triaged/integrated

## Comments

- 2026-02-05 agent (pi, terra/sol): round 2 authoring; user approved sketch ("looks cool") and confirmed hot-spare semantics (global per kind, automatic, surplus discarded).
