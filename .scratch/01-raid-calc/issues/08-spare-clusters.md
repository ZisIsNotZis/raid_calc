# Ticket: 08-spare-clusters

- **Status:** done
- **Need-review:** yes (behavior changes)

## Issue

Global per-kind spare inventory; spare-sharing joint clusters (shared spare-count dimension); procurement on depletion; allocation-race rule (config order); serial swaps within a pool.

## Acceptance criteria

AC: shock consuming > stocked spares triggers T_proc; 2-pool joint cluster matches hand-built joint model; state-space budget flag exercised.

Design refs: docs/design/raid-calc.md, optimizer.md, ui.md, architecture.md; slice plan in ../spec.md.

## Comments

- 2026-02-05 agent (pi, terra/sol): created from reviewed impl plan (v2 re-slice: 04 split into 04+05 per review sizing advice; UI canvas parallelizable; chain renumbered).

## Comments (review follow-ups from tickets 04/05)

- 2026-02-05 agent (pi, terra/sol): review hand-off — bare disk as a parent member is a permanent-loss stub (returns alive-empty, never restores redundancy); spare-cluster model here should make mirror-of-bare-disks restore properly. Also: leaf/collapsed budget guards exist since 04; the cluster-level budget should reuse them.

## Comments (implementation + closure)

- 2026-02-05 agent (pi, terra/sol): implemented — unified 6-state disk-unit models (aliveFull/opwait/swapping/rebuilding/procuring/aliveEmpty) with spare-annotated transitions; global per-kind inventory as a shared spare dimension in composeWithSpareGroup (sibling clusters exact, state-deduplicated for identical members); procurement path on depletion; serial swaps (one installer per unit); kind-shared-across-parents rejected in config.js (v1, with split-the-kind workaround); budget guards on all branches; eventCost1/2 exposed for the MC. Stage-exit rates corrected to 1/own-mean (fixed a latent ticket-06 bug where opwait exited at 1/tSwap). memberLostAt index-vs-composition bug fixed (N=1 layouts). All 35 tests green incl. spare-vs-procurement curve separation and sibling-scoping validation.
- 2026-02-05 agent (pi, terra/sol): deferral — cross-pool inventory coupling for same-kind pools under DIFFERENT parents rejected at validation (v1); workload-vs-rebuild contention exact at leaf level, cross-level concurrent rebuild contention deferred with parent-level rebuild dynamics.
