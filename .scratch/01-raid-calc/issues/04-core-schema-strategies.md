# Ticket: 04-core-schema-strategies

- **Status:** claimed
- **Need-review:** yes (behavior changes)

## Issue

Config JSON schema (with schemaVersion, rebuildBw, lambdaCCDefault, inventory-consistency rule, state-space estimate) + validation; concat + strip strategies as the four functions (placement / ioFanout / readPathMap / lossWeights) with hand-computed worked-example tests. No solver yet.

## Acceptance criteria

AC: schema rejects invalid configs (units, ranges, inventory over-allocation); worked examples pass; concat loss follows raid-calc.md §3.2 (empty-beyond-frontier free, frontier+inside members lose used bytes).

Design refs: docs/design/raid-calc.md, optimizer.md, ui.md, architecture.md; slice plan in ../spec.md.

## Comments

- 2026-02-05 agent (pi, terra/sol): created from reviewed impl plan (v2 re-slice: 04 split into 04+05 per review sizing advice; UI canvas parallelizable; chain renumbered).
