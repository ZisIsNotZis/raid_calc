# Ticket: 05-split-strategy

- **Status:** ready-for-agent
- **Need-review:** yes (behavior changes)
- **Blocked by:** previous slice

## Issue

split(N,M): placement, IO fan-out, read-path map, loss weights; worked-example tests (D2 numeric constants finalized).

## Acceptance criteria

AC: worked examples pass; parity absorption factor per raid-calc.md §3.5; file-span granularity from avg file size (disclosed approximation).

Design refs: docs/design/raid-calc.md, optimizer.md, ui.md, architecture.md; slice plan in ../spec.md.

## Comments

- 2026-02-05 agent (pi, terra/sol): created from impl plan round.
