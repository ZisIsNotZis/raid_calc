# Ticket: 06-split-strategy

- **Status:** ready-for-agent
- **Need-review:** yes (behavior changes)

## Issue

split(N,M): placement, IO fan-out, read-path map, loss weights; worked-example tests finalizing the placement-map constants (formerly D2).

## Acceptance criteria

AC: worked examples pass; parity absorption factor per raid-calc.md §3.5; file-span granularity from avg file size (disclosed approximation).

Design refs: docs/design/raid-calc.md, optimizer.md, ui.md, architecture.md; slice plan in ../spec.md.

## Comments

- 2026-02-05 agent (pi, terra/sol): created from reviewed impl plan (v2 re-slice: 04 split into 04+05 per review sizing advice; UI canvas parallelizable; chain renumbered).
