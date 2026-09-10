# Ticket: 06-erasure-strategies

- **Status:** ready-for-agent
- **Need-review:** yes (behavior changes)

## Issue

split(N,M) and strip-split(N,M) (both in v1 scope — D4 resolved 2026-02-05): placement, IO fan-out, read-path map, loss weights for both accounting modes; worked-example tests finalizing the placement-map constants (formerly D2).

## Acceptance criteria

AC: worked examples pass for both strategies; parity absorption factor per raid-calc.md §3.5; mode-2 span granularity from avg file size (disclosed approximation); mode-1 and mode-2 curves differ where expected (strip vs split damage concentration).

Design refs: docs/design/raid-calc.md, optimizer.md, ui.md, architecture.md; slice plan in ../spec.md.

## Comments

- 2026-02-05 agent (pi, terra/sol): created from reviewed impl plan (v2 re-slice: 04 split into 04+05 per review sizing advice; UI canvas parallelizable; chain renumbered).
- 2026-02-05 agent (pi, terra/sol): re-scoped per user D4 decision — strip-split + mode 2 now v1 scope; renamed from 06-split-strategy.
