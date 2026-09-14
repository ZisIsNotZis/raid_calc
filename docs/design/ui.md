# UI — Design

Status: v2 (2026-09-13, ticket 14). Supersedes v1 wholesale — the v1 canvas borrowed free-form-graph
affordances (Node-RED/ComfyUI/Blender grammar: output node, one node per disk model, wire-drag with no
feedback) for what is a strict tree, so its affordances lied about the model. Companion to
`raid-calc.md` (model), `optimizer.md`, `architecture.md`. Sketch: `.scratch/01-raid-calc/ui-sketch.html`
(layout inspiration only; the interactions below are the truth).

## 1. Regions

Header (undo/redo, reset, import/export, scenario chip, **language**, **theme**, shortcuts, Results
toggle, Run, Auto-optimize), left sidebar (palette, **Disk library**, inventory, comparison pins), center
canvas, right properties panel, plus a bottom **results drawer** over the canvas.

**Language and theme** are environment choices, not project data, so the saved preference lives in
`localStorage` (and is mirrored into `config.ui.lang` / `ui.theme` so an exported config carries it).
Boot order: saved preference → config → browser/OS hint (`navigator.language`, `prefers-color-scheme`).
Translations live in `src/ui/i18n.js`, keyed by the English string so an untranslated string degrades to
readable English instead of an identifier (lookup is own-property only). The light theme is a
`[data-theme="light"]` variable set; structural colors (surfaces, borders, text, shadows, the canvas
grid, the minimap) come from those variables — translucent accent tints stay inline because they read
correctly in both themes. The smoke suite measures text contrast in light mode (≥ 4.5:1) rather than
trusting the palette.

Nothing is duplicated across regions. Top-level results have exactly one home (§5).

## 2. Model → UI mapping

- **Root pool = the root.** `config.tree` is the top-level pool; there is no output node. The root card
  carries a `TOP-LEVEL` badge and a **result ribbon** (§5); promotion of any pool to root is the action
  formerly known as "connect to output" (`connectPoolToOutput`, exposed as *Set as top-level*).
- **Disk kinds are a library, not nodes.** A kind is a shared reference; drawing one node per kind and
  wiring it into every pool that uses it is noise. Kinds appear in the sidebar **Disk library** and as
  inline chips (`4× HDD 8TB`) on the pools that reference them. Drag library → pool card to add a member.
- **Tree constraint stays.** Every node has at most one parent, no cycles, no multi-out. This is what the
  model allows; it buys exact auto-layout, cheap validation, and no wire spaghetti. Free-form routing is
  intentionally not offered.
- **Pool members** render as chips inside the card: kind chips (`4× HDD 8TB`, ✕, ± count) and pool chips
  (strategy + one-line summary, click to select). Strategy params (D/M, N/M), λ_cc and member ordering
  live in the properties panel; ↑/↓ reorder members (order is semantic for split/strip-split).

## 3. Canvas — navigation and position

- **Viewport**: wheel = zoom anchored at the cursor (0.25×–2×), space-drag or middle-drag = pan, `F` =
  fit to content, `0` = 100%. The canvas is a transformed `.world`; nodes are absolutely positioned
  children of it, wires are one SVG inside it. Port coordinates come from `offsetLeft/offsetTop`
  (world-local) — never `getBoundingClientRect`, which would break under zoom.
- **Minimap** (bottom-right): node rectangles + viewport rect; click or drag to move the view.
- **Empty-canvas gestures**: left-drag on empty canvas pans (a click without movement deselects),
  middle-drag and space-drag also pan, and the canvas is `user-select:none` so a drag never paints a
  text selection. Double-clicking empty canvas creates a pool there.
- **Sidebar drags suppress the native text drag** (`user-select:none` on the sidebar, `preventDefault`
  on `pointerdown`, and a `pointercancel` abort path). Without that the browser starts an HTML5 text
  drag on the row's label, which cancels the pointer sequence — no `pointerup` ever fires and the drop
  silently does nothing.
- **Free positions, explicit tidy.** `config.ui.pos[path] = {x,y}` holds user drags (part of the config,
  so it survives export/import). Nodes without a stored position are placed by the tidy-tree base layout.
  The `Tidy` button clears all stored positions (`ui.pos`), restoring the computed tree.
- **Positions survive structural edits** by object identity, not by index: graph operations return new
  configs that reuse untouched node objects, so re-keying walks the new tree and carries a stored
  position from its old path to its new path whenever the same node object appears. Insertions and
  deletions therefore never slide a neighbour's position onto the wrong node.
- **Collapse**: a chevron in a pool header hides its subtree (`ui.collapsed[path]`); edges re-route to the
  collapsed card.

## 4. Canvas — gestures

| Gesture | Effect |
|---|---|
| Pointer-drag a card (>4px), drop on empty canvas | Move (persists to `ui.pos`) |
| Pointer-drag a card, drop on a pool card | Re-parent: becomes a member of that pool (appended last) |
| Drag a library kind onto a pool card | Append a kind-ref member |
| Drag a library kind onto empty canvas | Create a one-disk pool at that point (refused with a toast when that kind has no free inventory) |
| Create where no pool can take a member (`strip`/`split` need an exact count) | The new pool is nested beside the nearest member by wrapping it, or appended to the nearest `concat` member; the exact counts above it are never touched |
| Drag the sidebar "Pool" item onto a pool card / empty canvas | Create a pool as that pool's member / at that point |
| Double-click empty canvas | Create a pool there |
| Drag a card's **top port** (`out`) | Re-link: the card detaches from its parent and follows the cursor; drop on another pool to re-parent |
| Release a link drag on empty canvas | **Cancels** — the link is kept. Cutting is explicit (`Del` on the selected wire, the hover ✕, or *Delete pool*); an aborted drag must never delete a node and its subtree |
| Release any drag on an *illegal* target | Reverts to where the gesture started, and the reason stays on screen — nothing is parked on top of the target |
| Click a wire | Selects it (highlight); `Del` removes it |
| Hover a wire, then click its ✕ | Removes that link (the button waits for the pointer to reach it) |
| Middle-drag | Pans (never moves a card); right-drag opens the context menu |
| Click a card | Select (properties panel); double-click a value on the card edits it in place |
| `Esc` | Cancel an in-flight drag / close palette / deselect |
| Drag a pool's **bottom port** (`in`) | Drop target only — the pool's member input; it holds many members, so it has no single link to grab |
| Right-click a card | Context menu: Set as top-level, Collapse, Add member pool, Wrap in a new pool, Copy config JSON, Delete |

Legality is computed **during** the drag by a pure predicate that returns `{ok, reason}`, so the reason
(`"a pool cannot contain its own ancestor"`, `"only a pool can be a member of a pool"`) is visible while
hovering instead of surfacing as a failure after release.

## 5. Results — ribbon, drawer, previews

- **Root card ribbon** (the single home for top-level results): E[lost]@T, P(any loss)@T, usable,
  rebuild slowdown, and a sparkline of E[lost](t). Click → opens the results drawer. Any config edit
  marks the ribbon **stale** ("config changed since this run — press R") but keeps the last run's
  numbers: blanking the primary readout on every keystroke would be worse than showing it flagged.
- **Results drawer** (bottom of the canvas, toggled from the ribbon, the header, or `G`): both charts at
  reading size — E[lost](t) on a **log y-axis**, P(any loss)(t) **linear 0–1** — for mode 1 (and mode 2
  side by side), plus the full metric list. Comparison overlays for pinned configs and optimizer top-3
  render here.
- **Every pool card carries its own E[lost](t) curve** — the canvas is an instrument, not a diagram.
  A cheap pass (9 points, state budget 2·10⁴, debounced 420 ms, skipped above 32 pools) evaluates each
  subtree; a card whose subtree is invalid (or too large) shows a muted `—` with the reason as its
  tooltip instead of a curve, and the async pass defers while a drag is live so a re-render can never
  yank a card out from under the pointer.
- **Per-node standalone preview**: selecting a pool shows three metrics (E[lost], P(any loss), rebuild
  slowdown) plus a sparkline in a **popover anchored under the selected card**, debounced 300 ms, with a
  reduced state budget so oversized subtrees fail fast; an invalid or oversized subtree says so in the
  popover instead of leaving it blank.
- **The preview workload is scaled by the subtree's share of top-level usable capacity** (and capped at
  99.9% of that subtree's own usable bytes). Without the cap a small subtree would fail validation
  outright ("storeTB exceeds usable capacity") and could never show a curve at all. The popover is deliberately *outside* the card: a card that grew
  after layout would move under the cursor (breaking the second click of a double-click) and could cover
  its own wire. It is `pointer-events:none`, so it can never intercept a gesture. Evaluations run on the
  main thread with a small point count and state budget; a Worker is deliberately **not** used
  (single-file bundle, no cross-origin worker) — v1's "computed in the worker" was never built and is
  dropped here rather than restated.
- **Drop preview** (the reason the canvas is an instrument, not a diagram): while hovering a legal drop
  target, a chip next to the cursor shows the metric deltas the drop would cause
  (`P 8.1% → 4.3%`, `E[lost] 1.2 → 0.4 TB`, `slowdown 3.1× → 1.4×`, `usable 40 → 36 TB`). Baseline and
  candidate are both evaluated with the same cheap settings (9 points, state budget 2·10⁴) so the
  comparison is like-for-like; nothing commits until release. Un-evaluable candidates say so.

## 6. Properties panel

Context form for the selection, validated live; invalid values highlighted, config flagged unrunnable.
**Run is disabled while the config is flagged unrunnable** (validation error, state-space budget exceeded,
infeasible workload) with an explanatory tooltip; the last good curves stay visible, dimmed.

- **Pool** — strategy, D/M or N/M, λ_cc, member list (± count, ↑/↓, ✕), *Set as top-level* (hidden on
  root), *Delete pool* (hidden on root), standalone preview.
- **Disk model** — kind params, inventory count, hot spares, *Delete disk model* (refused with a message
  while any pool references it).
- **Scenario** (`selection = "scenario"`, reachable from the header chip or the palette) — workload
  (store ≥, avg R/W, avg file size, horizon) and global timings (T_op, T_swap, T_proc, dedicated rebuild
  bandwidth, contention mode). This is the former Output node's form, in one place.

## 7. Palette and keyboard

`Ctrl+K` opens a fuzzy command palette: add disk model, add pool, tidy, fit, set as top-level, wrap in
a new pool, run, auto-optimize, open results, scenario, export/import, undo/redo, delete selection.
`?` opens the shortcut sheet. Keyboard: `Ctrl+Z`/`Ctrl+Shift+Z` undo/redo (a form field with uncommitted
text keeps native undo; a clean field lets the app-level undo through), `Del` delete selection,
`R` run, `T` tidy, `F` fit, `0` reset view, `G` results drawer, `Esc` cancel a drag, `Space`+drag pan.

Promoting a pool whose old root had other members asks once before nesting the old root under it, so no
configuration is ever silently discarded; its stored position follows the promoted node.

## 8. Auto-optimize surface

Modal: constraint fields, objective dropdown, depth selector → results table (top-3: design, both
metrics, usable, bottleneck) + "Show curve overlay" (renders into the results drawer) + "Apply #1 →
canvas". Feasible/evaluated counts and honesty labels shown (optimizer.md §6).

## 9. State & persistence

Config JSON (architecture.md §3) is the single source of truth; canvas, panels, optimizer all read/write
it. `config.ui` carries view state — `pos`, `view {x,y,zoom}`, `collapsed` — and is ignored by the
solver. `validate()` ignores unknown top-level keys, so `ui` needs no schema change and round-trips
through Export/Import for free. Autosave is deliberately **off**: refresh restores the known-good sample;
`Reset example` resets in-session.

## 10. Register

Dark theme (sketch-approved), vanilla DOM/SVG, no framework. First-run: sample config loaded, root card
with ribbon, palette hint chip. The naive path is "drag a disk from the library onto the root → Run".
