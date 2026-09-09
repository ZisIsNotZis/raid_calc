# UI — Design

Status: v1 (2026-02-05). Approved sketch: `.scratch/01-raid-calc/ui-sketch.html` (static mock, user-reviewed "looks cool"). Companion to `raid-calc.md` (model), `optimizer.md`, `architecture.md`.

## 1. Layout

Four regions (see sketch): header (mode chips, horizon, workload summary, Run / Auto-optimize / Import-Export), left sidebar (node palette, inventory with per-kind counts + spare counts + discard line, top-level result summary), center node canvas (dotted grid), right properties panel (selected node).

## 2. Node canvas (tree-constrained)

- **Node types**: `Disk model` (kind params: capacity, λ0, λr, λw, URE, R/W bandwidth), `Pool` (strategy dropdown + params; member input ports; shows member summary inline, e.g. "4× HDD 8TB"), `Output` (workload params, horizon, results + chart). One output node per canvas.
- **Tree constraint, deliberately**: every node has at most one parent; no cycles, no multi-out. This is what the model allows, and it buys deterministic auto-layout (tidy-tree, one-click "tidy"), trivial validation, and no wire spaghetti — free-form ComfyUI routing is intentionally not offered.
- **Typed ports**: disk-model outputs feed pool member inputs; pool outputs feed pool member inputs or the output node. Illegal connections rejected during drag (port highlights red).
- Pool nodes list members inline rather than one node per physical disk (12 individual disk nodes would be noise; the disk-model node carries params once, pools reference it by kind).
- Click node → properties panel; per-node **standalone preview** (that subtree's own E[loss]/P/rebuild-slowdown/usable) computed from the same engine — the graph doubles as an understanding tool.

## 3. Properties panel

Context form for the selected node. Pool: strategy, N/M or D/M, λ_cc. Disk: kind params. Output: workload rates, avg file size, store ≥ X, horizon, mode 1/2 display toggle. Global (header or output): T_op, T_swap, T_proc, spares per kind, contention on/off, time unit. Inputs validated live (units, ranges); invalid values highlighted, config flagged unrunnable.

## 4. Auto-optimize surface

Modal (per sketch): constraint fields, objective dropdown, depth selector → results table (top-3: design, both metrics, usable, bottleneck) + "Show curve overlay" + "Apply #1 → canvas". Feasible/evaluated counts and honesty labels shown (optimizer.md §6).

## 5. Results & charts

- Output node + top-level result summary (sidebar): E[lost bytes] @ T, P(any loss) @ T, usable, rebuild slowdown.
- Charts: E[lost](t) and P(any loss)(t) per top-level config, mode 1 (and mode 2 when D4 lands) side by side; comparison overlay for optimizer top-3 and for manually pinned configs.
- Per-node preview sparkline in properties panel.

## 6. State & persistence

Config JSON (the schema in architecture.md §3) is the single source of truth; canvas, panels, optimizer all read/write it. Autosave to localStorage; explicit Import/Export as `.json` files. Undo/redo over config edits (v1: simple stack).

## 7. Register

Dark theme (sketch-approved), vanilla DOM/SVG, no framework. First-run: empty canvas with one output node and a hint chip; the naive path is "add disk kind → build or optimize → run".
