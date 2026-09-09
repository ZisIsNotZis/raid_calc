# Ticket: 11-ui-results

- **Status:** ready-for-agent
- **Need-review:** yes (behavior changes)
- **Blocked by:** previous slice

## Issue

Output node + charts (E[loss], P any loss, mode toggle, comparison overlay), per-node standalone preview, optimizer modal wiring, worker integration for sweeps/MC.

## Acceptance criteria

AC: sketch example evaluates and renders; preview per node; optimizer apply paints canvas.

Design refs: docs/design/raid-calc.md, optimizer.md, ui.md, architecture.md; slice plan in ../spec.md.

## Comments

- 2026-02-05 agent (pi, terra/sol): created from impl plan round.
