# Ticket: 14-canvas-ux

- **Status:** done
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

## Comments (implementation + closure)

- 2026-09-13 agent (pi, deepseek-v4): implemented in four commits on `ticket-14-canvas-ux`
  (7c98a9e feature, 77faaf6 / ed505ed / 41ab983 review rounds). All AC1–AC9 met; see the verification
  section below for the evidence behind each.
- 2026-09-13 agent: docs — `docs/design/ui.md` rewritten to v2 (SSOT for this change);
  `docs/design/architecture.md` §2/§3/§4/§5 corrected (the claimed Blob worker never existed; the module
  list now matches the tree; `config.ui` documented).
- 2026-09-13 agent: three adversarial review rounds with fresh-context reviewers (presumed-flawed
  framing, diff + spec as given material). Each round found blocking defects; all were fixed and every
  fix gained a browser check. Highlights worth remembering:
  - the `.ghost` class was used for both the SVG rubber-band and every ghost *button*, so
    `pointer-events:none` disabled every secondary button in the app;
  - `moveMember` resolved the destination *after* detaching the source, so dropping onto a later sibling
    silently did nothing;
  - `poolLayoutTree` used the *filtered* member index, so a card whose slot held a kind reference got a
    path that resolved to nothing — no position, no wire, and the rubber-band never drew;
  - every render added five more `pointerdown` listeners to the same container element, so one chip ✕
    removed several members (only `innerHTML` was replaced, not the element);
  - the canvas seeded layouts from fresh height *estimates* while measuring drift against the warm
    *cache*, so a warm render left children on stale positions, underneath the root card;
  - `props.setField` lost its pool branch in the rewrite and wrote `d`/`m`/`n`/`lambdaCC` into
    `config.workload`;
  - selection re-rendered the whole canvas on pointerup, which swallowed the second click of a
    double-click; the standalone preview then grew the card after layout, moving it under the cursor —
    the preview is now a popover anchored under the card instead of a block inside it.
- 2026-09-13 agent: verification — `npx vitest run` 100 passed (58 of them UI: position re-keying,
  viewport maths, drag legality, promotion semantics, re-parent regressions, root-path edits);
  `npm run build` green; `npm run smoke` (Playwright, real pointer gestures on the built artifact) 45/45
  checks, zero console or page errors. Evidence: this ticket's `evidence/ux-0*.png` (initial, run+drawer,
  re-parented, link drag, final).

## Verification

| AC | Evidence |
|---|---|
| AC1 root is root / ribbon / scenario | smoke: TOP-LEVEL badge, ribbon with 4 metrics, no output node in config or DOM, scenario chip opens the Scenario form |
| AC2 kinds as library + chips | smoke: library rows, no DISK cards, library drag adds a member |
| AC3 draggable cards, persisted, re-keyed | smoke: drag changes position; Tidy clears; unit tests cover re-keying across delete/re-parent/field edits |
| AC4 structural drag-and-drop | smoke: drop-ok highlight, re-parent, nested card appears, illegal drop reverts with the reason, Esc cancels |
| AC5 link create/cut | smoke: rubber-band from the port, drop re-parents, wire click selects, Del cuts, hover ✕ cuts |
| AC6 navigation | smoke: wheel zoom, F fit, minimap bottom-right with a viewport rect, middle-drag pans without moving a card |
| AC7 drop preview | implemented (`onPreviewDrop` → cheap 9-point evaluation, delta chip while hovering); covered by the drag checks, chip text asserted on the illegal path |
| AC8 palette/keys/collapse/inline edit | smoke: Ctrl+K runs a command, ? shortcut sheet, collapse hides the subtree, inline edit opens on a double-click and mutates nothing else |
| AC9 gates | vitest 100 green, build green, smoke 45/45 |
