# Ticket: design docs round 2 (optimizer, UI, architecture) + impl plan

- **Status:** done
- **Need-review:** satisfied (fresh-context review done, verdict BLOCK → all findings triaged + integrated)

## Issue

Write down model updates (global per-kind spares, contention, bandwidth params), optimizer design, UI design, architecture — plus implementation plan — per user go-signal.

## Acceptance criteria

- [x] raid-calc.md → v3 (spare-sharing clusters, leftover-bandwidth contention, disk R/W bandwidth, D1 resolved)
- [x] docs/design/optimizer.md, ui.md, architecture.md authored
- [x] spec.md impl plan + tickets created
- [x] Fresh-context review done, findings triaged/integrated (evidence/review-02.md, verdict BLOCK — accepted F1–F10, M1–M6, sizing advice)

## Comments

- 2026-02-05 agent (pi, terra/sol): round 2 authoring; user approved sketch ("looks cool") and confirmed hot-spare semantics (global per kind, automatic, surplus discarded).
- 2026-02-05 agent (pi, terra/sol): review (pi-subagents reviewer, fork=false, high thinking): BLOCK verdict. Accepted + fixed: F1 concat loss direction inverted (model-truth math error), F2 cross-level rebuild bandwidth budget undefined, F3 state-space guard missing, F4 ticket-04 RAID5 AC depended on 06/07 (04 split into 04+05, RAID5 test moved to 05, tolerance ≤2%), F5 stale D1 (→ resolved), F6 schema missing fields (schemaVersion, rebuildBw, lambdaCCDefault, u derivation, inventory rule), F7 dangling D2 (→ renamed), F8 sketch mirror arithmetic (strip(6,0); mirrors = strip(1,1) in space; reference example pinned), F9 URE absorption factor table, F10 float claim reworded; M1 swap-race + serial-swap semantics, M2 inventory validation, M3 slowdown factor defined, M4 chart scales (log/linear), M5 preview semantics + worker/debounce, M6 Run-disabled behavior; sizing: 04 split, UI canvas parallelizable. Tickets re-sliced to 04–13 (self-authored, unclaimed). D4 remains user-gated.
