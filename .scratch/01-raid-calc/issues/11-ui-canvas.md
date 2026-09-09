# Ticket: 11-ui-canvas

- **Status:** ready-for-agent
- **Need-review:** yes (behavior changes)

## Issue

SVG node canvas (tidy-tree layout, typed ports, drag-connect validation), props panel forms, inventory sidebar, config JSON round-trip (localStorage + file), undo/redo. Parallelizable after 04 (needs schema only).

## Acceptance criteria

AC: sketch layout reproduced; invalid connections rejected; import/export round-trip with schemaVersion.

Design refs: docs/design/raid-calc.md, optimizer.md, ui.md, architecture.md; slice plan in ../spec.md.

## Comments

- 2026-02-05 agent (pi, terra/sol): created from reviewed impl plan (v2 re-slice: 04 split into 04+05 per review sizing advice; UI canvas parallelizable; chain renumbered).
