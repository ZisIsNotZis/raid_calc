# Ticket: 13-build-bundle

- **Status:** ready-for-agent
- **Need-review:** yes (behavior changes)

## Issue

esbuild single-file raid-calc.html (committed), inline worker via Blob, README quickstart tested offline.

## Acceptance criteria

AC: npm run build → artifact opens via file:// offline; smoke test loads sketch config and renders.

Design refs: docs/design/raid-calc.md, optimizer.md, ui.md, architecture.md; slice plan in ../spec.md.

## Comments

- 2026-02-05 agent (pi, terra/sol): created from reviewed impl plan (v2 re-slice: 04 split into 04+05 per review sizing advice; UI canvas parallelizable; chain renumbered).
