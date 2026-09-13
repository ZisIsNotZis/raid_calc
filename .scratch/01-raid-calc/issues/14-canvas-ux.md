# Ticket: 14-canvas-ux

- **Status:** claimed
- **Need-review:** yes (behavior changes)
- **Need-test-cases:** yes (position re-keying, drop-legality reasons, viewport math, wire hit model)

## Issue

The canvas borrowed free-form-graph grammar (Node-RED / ComfyUI / Blender) for a strict-tree model,
so its affordances lie about the model. User-reported, all reproduced in code:

1. **Cards not draggable** — no move handler exists; `tidyLayout()` is the only position source.
2. **Link creation invisible** — the drag rubber-band is a degenerate 1px dot at the cursor
   (`M mx my L mx+1 my+1`), and wires are drawn from the *card* bounding box, never from the ports.
3. **Link destruction undiscoverable** — the only path is select-parent → properties → member row → ✕.
4. **The Result node is conceptually wrong** — `config.tree` already is the root; the Output node is
   virtual yet sits above the root, duplicates the sidebar summary, and its topmost wire teaches the
   wrong hierarchy on first paint. Disk kinds are laid out as children of the result, which is false.

Plus: no zoom, no pan, no fit-to-view anywhere.

## Acceptance criteria

AC1. Root pool card **is** the root: distinct badge, result ribbon with E[lost] / P(any loss) / usable /
     rebuild-slowdown + sparkline; the Output node no longer exists. Workload + global params live in a
     single `scenario` selection. Sidebar top-level summary block removed (single home for results).
AC2. Disk kinds are a sidebar library plus inline chips on the pools that reference them — never canvas
     nodes. Dragging a library item onto a pool adds a member; drag-from-canvas kind nodes is gone.
AC3. Cards are draggable (pointer drag, 4px threshold), positions persist in `config.ui.pos` keyed by
     node path, and survive structural edits via object-identity re-keying. `Tidy` clears positions.
AC4. Drag-and-drop is structural: dropping a card on a pool re-parents it; dropping on canvas moves it;
     illegal targets show the reason while hovering; Esc cancels.
AC5. Link create: rubber-band drawn from the real source port, live legality (valid targets snap and
     highlight, invalid show why), release on empty canvas opens a quick-add menu. Link delete: click a
     wire then Del, hover ✕, or drag the wire off its port and drop on empty canvas.
AC6. Canvas navigation: wheel = cursor-anchored zoom, space/middle-drag = pan, `F` fit, `0` reset,
     minimap with viewport rect.
AC7. Drop preview: hovering a legal drop target shows a live delta chip
     (P(any loss), E[lost], rebuild slowdown, usable) computed from the cheap evaluator; nothing commits
     until release.
AC8. Command palette (`Ctrl+K`), keyboard map (undo/redo, Del, Esc, R, T, G, F, 0), collapse/expand pool
     cards, inline value editing on cards, per-node preview sparkline on the selected card.
AC9. `npm test` green, `npm run build` green, Playwright browser smoke: every interaction above is
     exercised in a real browser with screenshots as evidence.

Design refs: docs/design/ui.md (rewritten in this ticket), raid-calc.md §3, architecture.md §3.

## Comments

- 2026-09-13 agent (pi, deepseek-v4): created from user brainstorm round ("all use recommended; do all in
  one pass"). Decisions approved by user: root-card ribbon + chart drawer; disk kinds as sidebar library
  with inline chips; free drag + explicit Tidy.
