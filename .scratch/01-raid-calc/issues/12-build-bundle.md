# Ticket: 12-build-bundle

- **Status:** ready-for-agent
- **Need-review:** yes (behavior changes)
- **Blocked by:** previous slice

## Issue

esbuild single-file raid-calc.html (committed), inline worker via Blob, README quickstart tested offline.

## Acceptance criteria

AC: npm run build → artifact opens via file:// offline; smoke test loads sketch config and renders.

Design refs: docs/design/raid-calc.md, optimizer.md, ui.md, architecture.md; slice plan in ../spec.md.

## Comments

- 2026-02-05 agent (pi, terra/sol): created from impl plan round.
