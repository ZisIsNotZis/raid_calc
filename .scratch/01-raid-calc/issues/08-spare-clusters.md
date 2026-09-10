# Ticket: 08-spare-clusters

- **Status:** claimed
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
