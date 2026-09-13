# UI — Design

Status: v2 (2026-09-13, ticket 14). Supersedes v1 wholesale — the v1 canvas borrowed free-form-graph
affordances (Node-RED/ComfyUI/Blender grammar: output node, one node per disk model, wire-drag with no
feedback) for what is a strict tree, so its affordances lied about the model. Companion to
`raid-calc.md` (model), `optimizer.md`, `architecture.md`. Sketch: `.scratch/01-raid-calc/ui-sketch.html`
(layout inspiration only; the interactions below are the truth).

## 1. Regions

Header (undo/redo, reset, import/export, scenario chip, Run, Auto-optimize, Results toggle), left sidebar
(palette, **Disk library**, inventory, comparison pins), center canvas, right properties panel, plus a
bottom **results drawer** over the canvas.

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
| Pointer-drag a card, drop on a pool card | Re-parent: becomes a member of that pool |
| Pointer-drag a card, drop on the top/bottom edge of a pool card | Re-parent and insert first / last |
| Drag a library kind onto a pool card | Append a kind-ref member |
| Drag a card's **input port** away | Detach from its parent; drop on a pool to re-parent, on empty canvas to delete |
| Drag an **output port** | Create a link; legal targets highlight and snap, illegal targets show the reason |
| Release a link drag on empty canvas | Quick-add menu of legal containers for the dragged source |
| Click a wire | Select it (highlight); `Del` removes it |
| Hover a wire | ✕ button at the midpoint removes it |
| Click a card | Select (properties panel); double-click a value on the card edits it in place |
| `Esc` | Cancel drag / close palette / deselect |
| Right-click a card | Context menu: Set as top-level, Collapse, Delete, Copy config JSON |

Legality is computed **during** the drag by a pure predicate that returns `{ok, reason}`, so the reason
(`"a pool cannot contain its own ancestor"`, `"only a pool can be a member of a pool"`) is visible while
hovering instead of surfacing as a failure after release.

## 5. Results — ribbon, drawer, previews

- **Root card ribbon** (the single home for top-level results): E[lost]@T, P(any loss)@T, usable,
  rebuild slowdown, and a sparkline of E[lost](t). Click → opens the results drawer.
- **Results drawer** (bottom of the canvas, toggled from the ribbon, the header, or `G`): both charts at
  reading size — E[lost](t) on a **log y-axis**, P(any loss)(t) **linear 0–1** — for mode 1 (and mode 2
  side by side), plus the full metric list. Comparison overlays for pinned configs and optimizer top-3
  render here.
- **Per-node standalone preview**: selecting a pool evaluates that subtree standalone (workload scaled by
  its share of top-level usable capacity) and shows the four metrics as a sparkline + numbers on the
  card, debounced 300 ms, with a reduced state budget so oversized subtrees fail fast. Evaluations run on
  the main thread with a small point count and state budget — a Worker is deliberately **not** used in
  v1 (single-file bundle, no cross-origin worker); v1's "computed in the worker" claim was never built and
  is dropped here rather than restated.
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

`Ctrl+K` (or `/`) opens a fuzzy command palette: add disk model, add pool, tidy, fit, set as top-level,
collapse all, run, auto-optimize, open results, scenario, export/import, reset, undo/redo, delete
selection. Keyboard: `Ctrl+Z`/`Ctrl+Shift+Z` undo/redo, `Del` delete selection, `R` run, `T` tidy,
`F` fit, `0` reset view, `G` results drawer, `Esc` cancel, `Space`-drag pan.

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
