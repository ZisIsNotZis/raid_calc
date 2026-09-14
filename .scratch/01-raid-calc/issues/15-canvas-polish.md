# Ticket: 15-canvas-polish

- **Status:** done
- **Need-review:** yes (behavior changes)
- **Need-test-cases:** yes

## Issue

Six user-reported issues on top of ticket 14's canvas:

1. Dragging a card also selected page text (no `user-select` control on the canvas).
2. Holding empty space and dragging did not pan the canvas (only space/middle-drag did).
3. The sidebar "Build" items were click-only and targeted the *selection*, so they felt like they needed
   a selected node; nothing could be dragged out of the palette, a disk dropped on empty canvas did
   nothing, and empty canvas had no "create here" affordance.
4. Only the root card showed a result curve; every other node showed none.
5. Releasing a link drag in empty space deleted the node *and its subtree* — the user expected a no-op.
6. No language (Chinese/English) or theme (light/dark) selector.

## Acceptance criteria

AC1. No text selection occurs while dragging on the canvas; a card's inline editor still selects text.
AC2. Left-drag on empty canvas pans the view without moving any card; a click without movement deselects.
AC3. Palette "Pool" drags out (drop on a pool → member; drop on empty canvas → created there); dragging a
     library disk onto empty canvas creates a one-disk pool there; double-clicking empty canvas creates a
     pool there; every created pool is immediately valid (seeded with one disk) and keeps its drop position.
AC4. Every pool card shows its own E[lost](t) curve (root: the ribbon); un-previewable subtrees show a
     muted marker whose tooltip says why; the async pass never re-renders mid-drag.
AC5. Releasing a link in empty space cancels with an explanatory toast; nothing is deleted. Cutting stays
     explicit (Del on the selected wire, hover ✕, context-menu delete).
AC6. Header language (EN/中文) and theme (dark/light) selectors; preference survives refresh; both are
     mirrored into `config.ui`; light theme is a variable set (no hard-coded colors outside `:root`).

Design refs: docs/design/ui.md (§1, §3, §4, §5 — updated in this ticket), raid-calc.md, architecture.md.

## Comments

- 2026-09-13 agent (pi, deepseek-v4): created from the user's six-item list. Item 4 was verified against
  rendered pixels first (all cards already have identical 10px corners), which rules out "rounded
  corners" and confirms "curve" = the per-node result curve.

## Comments (implementation + closure)

- 2026-09-13 agent (pi, deepseek-v4): implemented (b7333c2 feature + review fixes), merged to master as
  the merge commit below; ticket done and lock released by that merge.
- 2026-09-13 agent: two adversarial review rounds, each finding blocking defects; all fixed with a
  smoke check per fix. The sharpest ones:
  - creating a pool appended to whatever pool was under the pointer, and `strip`/`split` pools accept an
    EXACT member count — the default sample's root is `strip(1,1)`, so every create invalidated the whole
    config. Creation now walks to the nearest ancestor that is a `concat` pool, or nests the new pool
    beside the nearest *pool* member by wrapping it (never a kind-ref member: one entry stands for
    `count` slots).
  - dragging out of the sidebar started a native HTML5 text drag, which cancels the pointer sequence:
    no `pointerup`, no drop, ghost leaked. This is the same user-reported class as AC1, one layer down.
  - a cancelled space-drag leaked `panCount`, permanently disabling the per-node curve pass.
  - seeding a disk without checking inventory created an invalid config.
  - the per-pool pass rebuilt the canvas and discarded the selected card's preview popover.
- 2026-09-13 agent: verification — vitest 111 passed (69 UI); `npm run build` green; `npm run smoke`
  52/52 with zero console/page errors; evidence `ux-01..05` (initial, run+drawer, re-parented, link drag,
  final) plus `ux-06-light-zh` and `ux-08-dark-with-curves`, all written by the suite so none can go
  stale silently.
