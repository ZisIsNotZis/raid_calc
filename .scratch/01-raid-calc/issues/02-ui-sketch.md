# Ticket: UI sketch for review

- **Status:** done
- **Need-review:** no (artifact FOR user review)

## Issue

Static HTML mock of the node-canvas UI, per user request, to review before functionality/UI design docs are written.

## Acceptance criteria

- [x] Concrete example config visible end-to-end (disk model → 3 leaf pools → top pool → output)
- [x] Node-canvas interaction implied (ports, palette, selected-node property panel)
- [x] Auto-optimize flow visible (constraints, feasibility counts, top-3 table, apply-to-canvas)
- [x] Global per-kind hot spare config visible (user-confirmed semantics)

## Comments

- 2026-02-05 agent (pi, terra/sol): artifact at ui-sketch.html; example: 12× HDD 8TB, 3× strip(3+1) leaves, split(2,1) top, 40TB stored. Static — no JS behavior.
