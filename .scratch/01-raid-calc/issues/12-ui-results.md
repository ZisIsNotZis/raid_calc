# Ticket: 12-ui-results

- **Status:** ready-for-agent
- **Need-review:** yes (behavior changes)

## Issue

Output node + charts (E[loss] log-y, P linear, mode toggle, comparison overlay), debounced worker previews, optimize modal wiring, Run disabled when unrunnable.

## Acceptance criteria

AC: sketch example evaluates and renders; per-node preview; optimizer apply paints canvas.

Design refs: docs/design/raid-calc.md, optimizer.md, ui.md, architecture.md; slice plan in ../spec.md.

## Comments

- 2026-02-05 agent (pi, terra/sol): created from reviewed impl plan (v2 re-slice: 04 split into 04+05 per review sizing advice; UI canvas parallelizable; chain renumbered).
