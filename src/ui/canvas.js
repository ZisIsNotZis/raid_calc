// Node-canvas model + renderer.
//
// Section A is the pure node model: paths, tree operations, drag-legality predicates. Every
// function takes the config and returns a NEW config (immutable style).
//   Node identity = path string: "tree" for the root pool, "tree.members[i]" for members,
//   "kinds.<id>" for disk models. The root IS the top-level pool; there is no output node.
// Section B renders the DOM: viewport, cards, wires, drag gestures, minimap.

import {
  NODE_W,
  WORLD_W,
  WORLD_H,
  PAD,
  canvasPositions,
  boundsOf,
  zoomAt,
  clampZoom,
  fitView,
  screenToWorld,
} from "./positions.js";

// ============================================================================================
// A. node model
// ============================================================================================

export function isPoolNode(node) {
  return !!node && node.node === "pool";
}

export function isKindNode(node) {
  return !!node && node.node === "kind";
}

// Walk all pool nodes (including the root). Calls cb(node, path).
export function walkPools(node, path, cb) {
  if (!node) return;
  if (isPoolNode(node)) {
    cb(node, path);
    (node.members || []).forEach((m, i) =>
      walkPools(m, `${path}.members[${i}]`, cb),
    );
  }
}

// Resolve a path into the config. Returns undefined if not found.
export function resolvePath(config, path) {
  if (path.startsWith("kinds.")) return config.kinds[path.slice(6)];
  return path.split(".").reduce((acc, part) => {
    if (acc === undefined || acc === null) return undefined;
    const m = /^members\[(\d+)\]$/.exec(part);
    if (m) return acc.members ? acc.members[Number(m[1])] : undefined;
    return acc[part];
  }, config);
}

// Replace the node at `path` with `value` (returns a new config).
export function setPath(config, path, value) {
  if (path.startsWith("kinds.")) {
    const id = path.slice(6);
    return { ...config, kinds: { ...config.kinds, [id]: value } };
  }
  const parts = path.split(".");
  if (parts[0] !== "tree")
    throw new Error(`cannot set path outside tree: ${path}`);
  if (parts.length === 1) return { ...config, tree: value };
  const setIn = (node, idx) => {
    const part = parts[idx];
    const m = /^members\[(\d+)\]$/.exec(part);
    if (m) {
      const nextMembers = node.members.slice();
      nextMembers[Number(m[1])] =
        idx === parts.length - 1
          ? value
          : setIn(nextMembers[Number(m[1])], idx + 1);
      return { ...node, members: nextMembers };
    }
    if (idx === parts.length - 1) return { ...node, [part]: value };
    return { ...node, [part]: setIn(node[part], idx + 1) };
  };
  return { ...config, tree: setIn(config.tree, 1) };
}

// "tree.members[2]" -> "tree"; null for the root.
export function parentPathOf(path) {
  const m = /^(.*)\.members\[(\d+)\]$/.exec(path);
  return m ? m[1] : null;
}

// "tree.members[2]" -> 2; null for the root.
export function memberSlotOf(path) {
  const m = /\.members\[(\d+)\]$/.exec(path);
  return m ? Number(m[1]) : null;
}

export function isDescendantPath(path, ancestorPath) {
  return path.startsWith(ancestorPath + ".members[");
}

// --- create / destroy ---------------------------------------------------------

export function canBeMemberOfPool(node) {
  return isPoolNode(node) || isKindNode(node);
}

// Disk model -> pool: append a kind-ref member {node:"kind", kind, count:1}.
export function connectDiskToPool(config, kindId, poolPath, { count = 1 } = {}) {
  const pool = resolvePath(config, poolPath);
  if (!isPoolNode(pool)) throw new Error(`not a pool: ${poolPath}`);
  if (count < 1 || !Number.isInteger(count))
    throw new Error("count must be a positive integer");
  return setPath(config, `${poolPath}.members`, [
    ...(pool.members || []),
    { node: "kind", kind: kindId, count },
  ]);
}

// What would promoting this pool to root cost? "swap" = the old root had no other members;
// "wrap" = the rest of the old tree would be kept as a member of the promoted pool.
export function setRootPlan(config, poolPath) {
  if (poolPath === "tree") return { kind: "noop", others: 0 };
  const parentPath = parentPathOf(poolPath);
  if (!parentPath) return { kind: "noop", others: 0 };
  const parent = resolvePath(config, parentPath);
  const outsideRoot = parentPath !== "tree";
  const oldRoot = resolvePath(config, "tree");
  // what the wrap would nest under the promoted pool, excluding the promoted pool itself: the
  // siblings it leaves behind, or the whole old root when the promoted pool came from deeper
  const others = outsideRoot
    ? (oldRoot.members || []).length
    : (parent.members || []).length - 1;
  return { kind: !outsideRoot && others === 0 ? "swap" : "wrap", others };
}

export function setRoot(config, poolPath, { wrap = false } = {}) {
  if (poolPath === "tree") return config;
  const plan = setRootPlan(config, poolPath);
  if (plan.kind === "noop") return config;
  if (plan.kind === "wrap" && !wrap)
    throw new Error(
      `promoting this pool would strand ${plan.others} other node(s) — confirm to keep them under it`,
    );
  const src = resolvePath(config, poolPath);
  if (!isPoolNode(src)) throw new Error("only a pool can become the root");
  const parentPath = parentPathOf(poolPath);
  const slot = memberSlotOf(poolPath);
  const parent = resolvePath(config, parentPath);
  const rest = setPath(
    config,
    `${parentPath}.members`,
    parent.members.filter((_, i) => i !== slot),
  );
  if (plan.kind === "swap") return { ...rest, tree: src };
  const oldRoot = resolvePath(rest, "tree");
  const members = isPoolNode(oldRoot) ? oldRoot.members : [];
  if (members.length === 0) return { ...rest, tree: src };
  return { ...rest, tree: { ...src, members: [...(src.members || []), oldRoot] } };
}

// --- move / re-parent ---------------------------------------------------------

// Can `nodePath` become a member of `targetPoolPath`? The reason is surfaced while dragging, so
// an illegal target explains itself instead of failing after the drop.
export function canReparent(config, nodePath, targetPoolPath) {
  if (!nodePath || !targetPoolPath) return { ok: false, reason: "nothing to place" };
  if (nodePath === "tree")
    return { ok: false, reason: "the root is the top level — promote another pool instead" };
  if (nodePath === targetPoolPath)
    return { ok: false, reason: "a pool cannot contain itself" };
  if (isDescendantPath(targetPoolPath, nodePath))
    return { ok: false, reason: "a pool cannot contain its own descendant" };
  const node = resolvePath(config, nodePath);
  const target = resolvePath(config, targetPoolPath);
  if (!target) return { ok: false, reason: "target no longer exists" };
  if (!isPoolNode(target)) return { ok: false, reason: "only a pool can hold members" };
  if (!canBeMemberOfPool(node))
    return { ok: false, reason: "only pools and disk models can be members" };
  return { ok: true, reason: "" };
}

// After removing the member at (parentPath, slot), where does `path` point now? Only the first
// array step at the same level shifts; deeper steps and ancestors are unaffected.
export function remapAfterRemoval(path, parentPath, slot) {
  const prefix = `${parentPath}.members[`;
  if (!path.startsWith(prefix)) return path;
  const m = /^(\d+)\](.*)$/.exec(path.slice(prefix.length));
  if (!m) return path;
  const k = Number(m[1]);
  return `${prefix}${k > slot ? k - 1 : k}]${m[2]}`;
}

// Move a node to another pool (or to a new slot in the same pool). `slot` indexes the RESULTING
// member array of the destination (remove, then insert); null appends.
// The destination path is remapped for the removal before it is resolved: resolving it afterwards
// breaks whenever the destination is a later sibling, whose index shifts out from under its path.
// Both steps are immutable `setPath` edits, so untouched node objects keep their identity —
// positions rely on that (positions.js rekeyPositions).
export function moveMember(config, nodePath, targetPoolPath, slot = null) {
  const check = canReparent(config, nodePath, targetPoolPath);
  if (!check.ok) throw new Error(check.reason);
  const src = resolvePath(config, nodePath);
  const oldParentPath = parentPathOf(nodePath);
  const oldSlot = memberSlotOf(nodePath);
  const parent = resolvePath(config, oldParentPath);
  if (!isPoolNode(parent)) throw new Error(`not a pool: ${oldParentPath}`);
  const cfg = setPath(
    config,
    `${oldParentPath}.members`,
    parent.members.filter((_, i) => i !== oldSlot),
  );
  const newTargetPath = remapAfterRemoval(targetPoolPath, oldParentPath, oldSlot);
  const target = resolvePath(cfg, newTargetPath);
  if (!isPoolNode(target)) throw new Error(`not a pool: ${targetPoolPath}`);
  const members = target.members.slice();
  let s = slot === null ? members.length : slot;
  s = Math.max(0, Math.min(s, members.length));
  members.splice(s, 0, src);
  return setPath(cfg, `${newTargetPath}.members`, members);
}

export function removeNode(config, nodePath) {
  const parentPath = parentPathOf(nodePath);
  if (!parentPath)
    throw new Error("the root cannot be deleted — promote another pool first");
  const parent = resolvePath(config, parentPath);
  if (!isPoolNode(parent)) throw new Error(`not a pool: ${parentPath}`);
  const slot = memberSlotOf(nodePath);
  return setPath(
    config,
    `${parentPath}.members`,
    parent.members.filter((_, i) => i !== slot),
  );
}

export function reorderMember(config, poolPath, slot, delta) {
  const pool = resolvePath(config, poolPath);
  if (!isPoolNode(pool)) throw new Error(`not a pool: ${poolPath}`);
  const to = slot + delta;
  if (to < 0 || to >= pool.members.length) return config;
  const members = pool.members.slice();
  const [moved] = members.splice(slot, 1);
  members.splice(to, 0, moved);
  return setPath(config, `${poolPath}.members`, members);
}

export function setMemberCount(config, poolPath, slot, count) {
  const pool = resolvePath(config, poolPath);
  if (!isPoolNode(pool)) throw new Error(`not a pool: ${poolPath}`);
  return setPath(
    config,
    `${poolPath}.members`,
    pool.members.map((m, i) =>
      i === slot && isKindNode(m) ? { ...m, count: Math.max(1, count) } : m,
    ),
  );
}

export function addPool(
  config,
  { strategy = "concat", parentPath = "tree", slotIndex = null } = {},
) {
  const pool = { node: "pool", strategy, lambdaCC: 0, members: [] };
  if (strategy !== "concat") pool[strategy === "strip" ? "d" : "n"] = 1;
  if (strategy !== "concat") pool.m = 0;
  if (parentPath === null) return { ...config, tree: pool };
  const parent = resolvePath(config, parentPath);
  if (!isPoolNode(parent)) throw new Error(`not a pool: ${parentPath}`);
  const members = parent.members.slice();
  if (slotIndex === null) members.push(pool);
  else members.splice(slotIndex, 0, pool);
  return setPath(config, `${parentPath}.members`, members);
}

// --- disk models (sidebar library) --------------------------------------------

export function kindUsage(config, kindId) {
  let n = 0;
  walkPools(config.tree, "tree", (node) =>
    (node.members || []).forEach((m) => {
      if (isKindNode(m) && m.kind === kindId) n += m.count;
    }),
  );
  return n;
}

export function removeKind(config, kindId) {
  if (!config.kinds[kindId]) throw new Error(`unknown disk model: ${kindId}`);
  if (Object.keys(config.kinds).length <= 1)
    throw new Error("the config needs at least one disk model");
  const used = kindUsage(config, kindId);
  if (used > 0)
    throw new Error(
      `${kindId} is still referenced by ${used} member(s) — remove them first`,
    );
  const kinds = { ...config.kinds };
  delete kinds[kindId];
  return { ...config, kinds };
}

// ============================================================================================
// B. renderer
// ============================================================================================

const SVG_NS = "http://www.w3.org/2000/svg";
const PORT_HALF = 7;

// Sparkline path from a value series (pure; unit-tested).
export function sparkPath(values, w, h, pad = 3) {
  if (!values || values.length < 2) return "";
  const max = values.reduce((a, b) => Math.max(a, b), 1e-30);
  let d = "";
  for (let i = 0; i < values.length; i++) {
    const x = pad + (i / (values.length - 1)) * (w - pad * 2);
    const v = values[i] / max;
    const y = h - pad - Math.max(0, Math.min(1, v)) * (h - pad * 2);
    d += (i === 0 ? "M" : " L") + ` ${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return d;
}

// Bind the container's listeners exactly once; the body dispatches through `container.__ctx`, which
// each render replaces with handlers closing over that render's state.
function mountCanvas(container) {
  if (container.__mounted) return;
  container.__mounted = true;
  const call = (name) => (e) => {
    const ctx = container.__ctx;
    if (ctx && ctx[name]) ctx[name](e);
  };
  container.addEventListener("pointerdown", call("pointerdown"));
  container.addEventListener("pointerdown", call("spacePan"));
  container.addEventListener("pointerdown", call("middlePan"));
  container.addEventListener("contextmenu", call("contextmenu"));
  container.addEventListener("dblclick", call("dblclick"));
  container.addEventListener("wheel", call("wheel"), { passive: false });
}

function el(tag, text) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  return n;
}

function svgEl(tag) {
  return document.createElementNS(SVG_NS, tag);
}

function expfmt(v) {
  if (!Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  return v.toExponential(1);
}

function kvRow(key, label, value, { editable = true } = {}) {
  const row = el("div");
  row.className = "kv";
  if (key && editable) {
    row.dataset.key = key;
    row.dataset.editable = "1";
  }
  row.appendChild(el("span", label));
  row.appendChild(el("b", value));
  return row;
}

// Rough card height before the DOM exists; the measured height replaces it immediately after
// insertion, and one correction pass re-lays-out anything the estimate misplaced.
function estimateHeight(id, config, collapsed) {
  if (collapsed) return 62;
  const node = resolvePath(config, id);
  const root = id === "tree";
  if (!isPoolNode(node)) return 140;
  let h = 46 + (node.members || []).length * 22 + 19 * 2 + 10;
  if (root) h += 96; // ribbon
  return h;
}

// Tiny inline chart for cards. Exported so main.js can reuse it in the drawer legend.
export function sparkSvg(values, w, h) {
  const svg = svgEl("svg");
  svg.setAttribute("class", "spark");
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(h));
  const path = svgEl("path");
  path.setAttribute("d", sparkPath(values, w, h));
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "var(--accent2)");
  path.setAttribute("stroke-width", "1.5");
  svg.appendChild(path);
  return svg;
}

// Fill the standalone-preview popover. Exported so main.js can refresh it in place.
export function renderPreviewBlock(box, p) {
  box.innerHTML = "";
  if (!p) {
    box.appendChild(el("div", "preview…"));
    return;
  }
  if (p.error) {
    const n = el("div", `preview unavailable: ${p.error}`);
    n.className = "np-err";
    box.appendChild(n);
    return;
  }
  for (const [v, k] of [
    [p.fmt.lost, "E[lost]"],
    [p.fmt.anyLossPct, "P(loss)"],
    [p.fmt.slowdown, "slowdown"],
  ]) {
    const row = el("div");
    row.className = "np-row";
    row.appendChild(el("span", k));
    row.appendChild(el("b", v));
    box.appendChild(row);
  }
  if (p.series) box.appendChild(sparkSvg(p.series, 176, 26));
}

export function renderCanvas({
  container,
  config,
  selection,
  selWire = null,
  ui = {},
  results = new Map(),
  heights = new Map(),
  actions = {},
}) {
  const pos = ui.pos || {};
  const collapsed = ui.collapsed || {};
  const view = { ...(ui.view || { x: 40, y: 20, zoom: 1 }) };

  container.innerHTML = "";

  const world = el("div");
  world.className = "world";
  const wires = svgEl("svg");
  wires.setAttribute("class", "wires");
  wires.setAttribute("width", String(WORLD_W));
  wires.setAttribute("height", String(WORLD_H));
  const edgeLayer = svgEl("g");
  const ghostLayer = svgEl("g");
  wires.appendChild(edgeLayer);
  wires.appendChild(ghostLayer);
  world.appendChild(wires);

  const cards = new Map();
  const positions = new Map();
  let cardDragging = false;

  const applyView = () => {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
    const label = container.querySelector(".zoom-label");
    if (label) label.textContent = `${Math.round(view.zoom * 100)}%`;
    drawMinimap();
  };

  const place = (id, xy) => {
    positions.set(id, xy);
    const c = cards.get(id);
    if (c && !cardDragging) {
      c.el.style.left = `${xy.x}px`;
      c.el.style.top = `${xy.y}px`;
    }
  };

  // ---- card content ----------------------------------------------------------

  const memberChips = (id, node) => {
    const wrap = el("div");
    wrap.className = "chips";
    (node.members || []).forEach((m, i) => {
      const chip = el("span");
      chip.className = "chip " + (isKindNode(m) ? "kind" : "pool");
      if (isKindNode(m)) {
        const kind = config.kinds[m.kind];
        chip.appendChild(el("b", String(m.count)));
        chip.appendChild(
          el("i", `× ${m.kind}${kind ? " " + kind.capacityTB + "TB" : ""}`),
        );
        const minus = el("button", "−");
        minus.type = "button";
        minus.className = "x";
        minus.dataset.act = "count";
        minus.dataset.path = id;
        minus.dataset.slot = String(i);
        minus.dataset.delta = "-1";
        const plus = el("button", "+");
        plus.type = "button";
        plus.className = "x";
        plus.dataset.act = "count";
        plus.dataset.path = id;
        plus.dataset.slot = String(i);
        plus.dataset.delta = "1";
        chip.appendChild(minus);
        chip.appendChild(plus);
      } else {
        const sel = el("span");
        sel.className = "chip-link";
        sel.dataset.act = "select";
        sel.dataset.path = `${id}.members[${i}]`;
        sel.appendChild(el("b", m.strategy));
        sel.appendChild(el("i", `${(m.members || []).length} member(s)`));
        chip.appendChild(sel);
      }
      const x = el("button", "✕");
      x.type = "button";
      x.className = "x rm";
      x.title = "remove member";
      x.dataset.act = "remove";
      x.dataset.path = id;
      x.dataset.slot = String(i);
      chip.appendChild(x);
      wrap.appendChild(chip);
    });
    const add = el("span");
    add.className = "chip add";
    add.textContent = "+";
    add.title = "add a member (or drop a disk model from the library here)";
    add.dataset.act = "addmember";
    add.dataset.path = id;
    wrap.appendChild(add);
    return wrap;
  };

  // Re-measure cards and re-place the auto-laid-out ones. Called whenever something changes a
  // card's height outside a render (the standalone-preview block arrives asynchronously), because a
  // grown card would otherwise sit on top of its own wire.
  const reflow = () => {
    placePopover();
    let drifted = false;
    const live = new Set();
    for (const [id, c] of cards) {
      const h = c.el.offsetHeight;
      const prev = heights.get(id);
      if (prev === undefined || Math.abs(prev - h) > 4) drifted = true;
      heights.set(id, h);
      live.add(id);
    }
    for (const id of [...heights.keys()]) if (!live.has(id)) heights.delete(id);
    if (!drifted) return false;
    applyBaseLayout(heights);
    for (const [id, p] of Object.entries(pos))
      if (positions.has(id) && p) place(id, { x: p.x + PAD, y: p.y + PAD });
    drawEdges();
    return true;
  };

  // Selection without a re-render: a rebuild here would swallow the second click of a double-click.
  const setSelectionInPlace = (next) => {
    selection = next;
    for (const [id, c] of cards) c.el.classList.toggle("sel", id === next);
    showPreview(next, results.get(next));
    drawMinimap();
  };

  // The preview is a popover anchored under the selected card, NOT a block inside it: growing a card
  // after layout would move it (breaking the second click of a double-click) and let it cover its own
  // wire. It is pointer-events:none, so it can never block a gesture.
  const popover = el("div");
  popover.className = "preview-pop";
  popover.hidden = true;
  world.appendChild(popover);
  let popId = null;

  const placePopover = () => {
    const c = popId ? cards.get(popId) : null;
    const p = popId ? positions.get(popId) : null;
    if (!c || !p || collapsed[popId]) {
      popover.hidden = true;
      return;
    }
    popover.hidden = false;
    popover.style.left = `${p.x}px`;
    popover.style.top = `${p.y + (c.el.offsetHeight || 140) + 10}px`;
    popover.style.width = `${NODE_W}px`;
  };

  const showPreview = (id, p) => {
    popId = id;
    if (!id) {
      popover.hidden = true;
      return;
    }
    renderPreviewBlock(popover, p);
    placePopover();
  };

  const drawCard = (id) => {
    const node = resolvePath(config, id);
    if (!isPoolNode(node)) return;
    const isRoot = id === "tree";
    const isCollapsed = !!collapsed[id];
    const card = el("div");
    card.className = "node pool" + (selection === id ? " sel" : "");
    if (isRoot) card.classList.add("root");
    card.dataset.id = id;
    card.style.width = `${NODE_W}px`;

    const hd = el("div");
    hd.className = "hd";
    const chev = el("span", isCollapsed ? "▸" : "▾");
    chev.className = "chev";
    chev.dataset.act = "collapse";
    chev.dataset.path = id;
    chev.title = isCollapsed ? "expand" : "collapse";
    hd.appendChild(chev);
    const dot = el("span");
    dot.className = "dot";
    dot.style.background = isRoot ? "var(--accent2)" : "var(--accent)";
    hd.appendChild(dot);
    const slot = memberSlotOf(id);
    hd.appendChild(el("span", isRoot ? "root" : `pool ${slot !== null ? slot + 1 : ""}`));
    const badge = el("span", isRoot ? "TOP-LEVEL" : node.strategy.toUpperCase());
    badge.className = "badge";
    hd.appendChild(badge);
    card.appendChild(hd);

    if (isRoot) {
      const r = results.get("tree");
      const rib = el("div");
      rib.className = "ribbon" + (r ? "" : " muted");
      rib.dataset.act = "results";
      rib.title = "click for the full results drawer";
      if (r) {
        const grid = el("div");
        grid.className = "rb-grid";
        for (const [v, k] of [
          [r.fmt.lost, "E[lost]"],
          [r.fmt.anyLossPct, "P(any loss)"],
          [r.fmt.usable, "usable"],
          [r.fmt.slowdown, "slowdown"],
        ]) {
          const cell = el("div");
          cell.className = "rb-cell";
          const vEl = el("div", v);
          vEl.className = "rb-v";
          const kEl = el("div", k);
          kEl.className = "rb-k";
          cell.appendChild(vEl);
          cell.appendChild(kEl);
          grid.appendChild(cell);
        }
        rib.appendChild(grid);
        if (r.series) rib.appendChild(sparkSvg(r.series, 168, 32));
        if (r.stale) {
          const stale = el("div", "config changed since this run — press R");
          stale.className = "rb-stale";
          rib.appendChild(stale);
        }
      } else {
        rib.appendChild(el("div", "no run yet — press R"));
      }
      card.appendChild(rib);
    }

    const bd = el("div");
    bd.className = "bd";
    if (isCollapsed) {
      bd.appendChild(
        kvRow(null, "members", `${(node.members || []).length} hidden`),
      );
    } else {
      const strategyText =
        node.strategy === "strip"
          ? `strip ${node.d ?? 1}+${node.m ?? 0}`
          : node.strategy === "split" || node.strategy === "strip-split"
            ? `${node.strategy} ${node.n ?? 1}+${node.m ?? 0}`
            : "concat";
      bd.appendChild(kvRow(null, "strategy", strategyText));
      bd.appendChild(kvRow("lambdaCC", "λcc /h", expfmt(node.lambdaCC)));
      bd.appendChild(memberChips(id, node));
    }
    card.appendChild(bd);

    if (!isRoot) {
      const out = el("div");
      out.className = "port out";
      out.dataset.port = "out";
      out.dataset.path = id;
      out.title = "drag to re-parent · drop on empty canvas to cut the link";
      card.appendChild(out);
    }
    const inn = el("div");
    inn.className = "port in";
    inn.dataset.port = "in";
    inn.dataset.path = id;
    inn.title = "member input — drop a pool here";
    card.appendChild(inn);

    card.dataset.baseTitle = card.title || "";
    world.appendChild(card);
    cards.set(id, { el: card });
  };

  // ---- wires ------------------------------------------------------------------

  const portCenter = (id, side) => {
    const c = cards.get(id);
    const p = positions.get(id);
    if (!c || !p) return null;
    const port = c.el.querySelector(`.port.${side}`);
    if (!port) return null;
    return {
      x: p.x + port.offsetLeft + PORT_HALF,
      y: p.y + port.offsetTop + PORT_HALF,
    };
  };

  const wireD = (a, b) => {
    const midY = (a.y + b.y) / 2;
    return `M ${a.x} ${a.y} C ${a.x} ${midY}, ${b.x} ${midY}, ${b.x} ${b.y}`;
  };

  const edges = new Map();

  const drawEdges = () => {
    edgeLayer.innerHTML = "";
    edges.clear();
    for (const [childId] of cards) {
      const parentId = parentPathOf(childId);
      if (!parentId || !cards.has(parentId)) continue;
      const a = portCenter(childId, "out");
      const b = portCenter(parentId, "in");
      if (!a || !b) continue;
      const d = wireD(a, b);
      const path = svgEl("path");
      path.setAttribute("d", d);
      path.setAttribute("class", "wire" + (selWire === childId ? " sel" : ""));
      const hit = svgEl("path");
      hit.setAttribute("d", d);
      hit.setAttribute("class", "wire-hit");
      hit.dataset.child = childId;
      edgeLayer.appendChild(path);
      edgeLayer.appendChild(hit);
      edges.set(childId, { path, hit, a, b });
      if (selWire === childId) appendCutButton(childId, a, b);
    }
    drawMinimap();
  };

  const appendCutButton = (childId, a, b) => {
    const bx = (a.x + b.x) / 2 + 10;
    const by = (a.y + b.y) / 2 - 9;
    const g = svgEl("g");
    g.setAttribute("class", "cut-btn");
    g.dataset.act = "cut";
    g.dataset.child = childId;
    const c = svgEl("circle");
    c.setAttribute("cx", String(bx));
    c.setAttribute("cy", String(by));
    c.setAttribute("r", "9");
    const t = svgEl("text");
    t.setAttribute("x", String(bx));
    t.setAttribute("y", String(by + 3.5));
    t.setAttribute("text-anchor", "middle");
    t.textContent = "✕";
    g.appendChild(c);
    g.appendChild(t);
    edgeLayer.appendChild(g);
  };

  // ---- minimap ----------------------------------------------------------------

  const minimap = svgEl("svg");
  minimap.setAttribute("class", "minimap");
  minimap.setAttribute("width", "168");
  minimap.setAttribute("height", "112");

  const nodeSize = (id) => {
    const c = cards.get(id);
    return c
      ? { w: c.el.offsetWidth || NODE_W, h: c.el.offsetHeight || 140 }
      : { w: NODE_W, h: 140 };
  };

  function drawMinimap() {
    if (!positions.size) return;
    const b = boundsOf(positions, nodeSize);
    const scale = Math.min(
      160 / Math.max(1, b.x1 - b.x0),
      104 / Math.max(1, b.y1 - b.y0),
    );
    const tx = (x) => 4 + (x - b.x0) * scale;
    const ty = (y) => 4 + (y - b.y0) * scale;
    minimap.innerHTML = "";
    for (const [id, p] of positions) {
      const s = nodeSize(id);
      const r = svgEl("rect");
      r.setAttribute("x", String(tx(p.x)));
      r.setAttribute("y", String(ty(p.y)));
      r.setAttribute("width", String(Math.max(2, s.w * scale)));
      r.setAttribute("height", String(Math.max(2, s.h * scale)));
      r.setAttribute("rx", "1.5");
      r.setAttribute("class", id === selection ? "mm-sel" : "mm-node");
      minimap.appendChild(r);
    }
    const v = svgEl("rect");
    v.setAttribute("x", String(tx(-view.x / view.zoom)));
    v.setAttribute("y", String(ty(-view.y / view.zoom)));
    v.setAttribute("width", String(Math.min(160, (container.clientWidth / view.zoom) * scale)));
    v.setAttribute("height", String(Math.min(104, (container.clientHeight / view.zoom) * scale)));
    v.setAttribute("class", "mm-view");
    minimap.appendChild(v);
    minimap.dataset.scale = String(scale);
    minimap.dataset.originX = String(b.x0);
    minimap.dataset.originY = String(b.y0);
  }

  minimap.addEventListener("pointerdown", (e) => {
    e.stopPropagation(); // otherwise the canvas treats it as a click on empty space and deselects
    const scale = Number(minimap.dataset.scale) || 1;
    const x0 = Number(minimap.dataset.originX) || 0;
    const y0 = Number(minimap.dataset.originY) || 0;
    const r = minimap.getBoundingClientRect();
    const go = (ev) => {
      const wx = (ev.clientX - r.left - 4) / scale + x0;
      const wy = (ev.clientY - r.top - 4) / scale + y0;
      view.x = container.clientWidth / 2 - wx * view.zoom;
      view.y = container.clientHeight / 2 - wy * view.zoom;
      applyView();
    };
    go(e);
    const move = (ev) => go(ev);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (actions.onView) actions.onView({ ...view });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  // ---- hud --------------------------------------------------------------------

  const hud = el("div");
  hud.className = "hud";
  const tidyBtn = el("button", "Tidy");
  tidyBtn.className = "ghost tiny";
  tidyBtn.dataset.act = "tidy";
  tidyBtn.title = "forget manual positions and re-run the auto layout";
  const fitBtn = el("button", "Fit");
  fitBtn.className = "ghost tiny";
  fitBtn.dataset.act = "fit";
  const zhint = el("span", "space+drag pan · wheel zoom · ctrl+K commands");
  zhint.className = "hud-hint";
  const zoomLabel = el("span", `${Math.round(view.zoom * 100)}%`);
  zoomLabel.className = "zoom-label";
  hud.appendChild(tidyBtn);
  hud.appendChild(fitBtn);
  hud.appendChild(zhint);
  hud.appendChild(zoomLabel);

  const chip = el("div");
  chip.className = "drag-chip";
  chip.hidden = true;

  container.appendChild(world);
  container.appendChild(hud);
  container.appendChild(minimap);
  container.appendChild(chip);

  // ---- gesture plumbing -------------------------------------------------------

  let gesture = null;
  let hoverCut = null;

  const canvasPoint = (e) => {
    const r = container.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const worldPoint = (e) => {
    const p = canvasPoint(e);
    return screenToWorld(view, p.x, p.y);
  };

  const cardUnder = (clientX, clientY) => {
    const node = document.elementFromPoint(clientX, clientY);
    const card = node && node.closest(".node");
    return card ? card.dataset.id : null;
  };

  const clearTargetStyles = () => {
    for (const c of cards.values()) {
      c.el.classList.remove("drop-ok", "drop-bad");
      if (c.el.dataset.baseTitle) c.el.title = c.el.dataset.baseTitle;
    }
  };

  const showChip = (clientX, clientY, delta) => {
    const r = container.getBoundingClientRect();
    chip.hidden = false;
    chip.style.left = `${clientX - r.left + 18}px`;
    chip.style.top = `${clientY - r.top + 14}px`;
    chip.innerHTML = "";
    if (!delta) {
      chip.appendChild(el("div", "checking…"));
      return;
    }
    if (!delta.ok) {
      chip.appendChild(el("div", "preview unavailable"));
      return;
    }
    for (const row of delta.rows) {
      const line = el("div");
      line.className = "dc-row";
      line.appendChild(el("span", row.label));
      line.appendChild(el("b", row.from));
      line.appendChild(el("span", "→"));
      const to = el("b", row.to);
      to.className = `dc-v ${row.dir}`;
      line.appendChild(to);
      chip.appendChild(line);
    }
  };

  const hideChip = () => {
    chip.hidden = true;
  };

  let hoverCutTimer = null;
  const removeHoverCut = () => {
    clearTimeout(hoverCutTimer);
    if (hoverCut) hoverCut.remove();
    hoverCut = null;
  };
  // Removing the button the instant the pointer leaves the wire makes it impossible to click: the
  // pointer must travel from the wire onto the button. Delay removal and let the button cancel it.
  const scheduleHoverCutRemoval = () => {
    clearTimeout(hoverCutTimer);
    hoverCutTimer = setTimeout(() => removeHoverCut(), 220);
  };
  const cancelHoverCutRemoval = () => clearTimeout(hoverCutTimer);

  const addHoverCut = (childId, a, b) => {
    if (hoverCut && hoverCut.dataset.child === childId) {
      cancelHoverCutRemoval();
      return;
    }
    removeHoverCut();
    const bx = (a.x + b.x) / 2 + 10;
    const by = (a.y + b.y) / 2 - 9;
    const g = svgEl("g");
    g.setAttribute("class", "cut-btn hover");
    const c = svgEl("circle");
    c.setAttribute("cx", String(bx));
    c.setAttribute("cy", String(by));
    c.setAttribute("r", "9");
    const t = svgEl("text");
    t.setAttribute("x", String(bx));
    t.setAttribute("y", String(by + 3.5));
    t.setAttribute("text-anchor", "middle");
    t.textContent = "✕";
    g.appendChild(c);
    g.appendChild(t);
    g.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      if (actions.onCutLink) actions.onCutLink(childId);
    });
    g.addEventListener("pointerenter", cancelHoverCutRemoval);
    g.addEventListener("pointerleave", scheduleHoverCutRemoval);
    g.dataset.child = childId;
    edgeLayer.appendChild(g);
    hoverCut = g;
  };

  // ---- pointer handling -------------------------------------------------------

  const unlisten = () => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    window.removeEventListener("keydown", onGestureKey);
  };
  const listen = () => {
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("keydown", onGestureKey);
  };

  // Abort without committing: Esc, a cancelled pointer, or a lost window. Restores the card where
  // the gesture started and drops every transient visual.
  const abortGesture = () => {
    const g = gesture;
    gesture = null;
    unlisten();
    hideChip();
    clearTargetStyles();
    ghostLayer.innerHTML = "";
    if (g && g.type === "move") {
      if (cardDragging) {
        cardDragging = false;
        const c = cards.get(g.id);
        if (c) c.el.classList.remove("dragging");
      }
      if (g.moved) {
        place(g.id, g.startPos);
        drawEdges();
      }
    }
    return !!g;
  };
  const onPointerCancel = () => abortGesture();
  const onGestureKey = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    abortGesture();
  };

  const onPointerMove = (e) => {
    if (!gesture) return;
    const dx = e.clientX - gesture.startClient.x;
    const dy = e.clientY - gesture.startClient.y;
    if (!gesture.moved && Math.hypot(dx, dy) < 4) return;
    gesture.moved = true;

    if (gesture.type === "move") {
      if (!cardDragging) {
        cardDragging = true;
        cards.get(gesture.id).el.classList.add("dragging");
      }
      const nx = gesture.startPos.x + dx / view.zoom;
      const ny = gesture.startPos.y + dy / view.zoom;
      positions.set(gesture.id, { x: nx, y: ny });
      const c = cards.get(gesture.id).el;
      c.style.left = `${nx}px`;
      c.style.top = `${ny}px`;
      drawEdges();
      placePopover();
      clearTargetStyles();
      const targetId = cardUnder(e.clientX, e.clientY);
      gesture.target = null;
      gesture.badTarget = null;
      if (targetId && targetId !== gesture.id) {
        const check = canReparent(config, gesture.id, targetId);
        const targetEl = cards.get(targetId).el;
        if (check.ok) {
          gesture.target = targetId;
          targetEl.classList.add("drop-ok");
          const key = `${gesture.id}->${targetId}`;
          if (key !== gesture.previewKey) {
            gesture.previewKey = key;
            gesture.delta = null;
            showChip(e.clientX, e.clientY, null);
            const delta =
              actions.onPreviewDrop &&
              actions.onPreviewDrop(gesture.id, targetId, null);
            if (delta) gesture.delta = delta;
            showChip(e.clientX, e.clientY, delta);
          } else {
            showChip(e.clientX, e.clientY, gesture.delta);
          }
        } else {
          targetEl.classList.add("drop-bad");
          targetEl.title = check.reason;
          gesture.badTarget = targetId;
          gesture.badReason = check.reason;
          gesture.previewKey = null;
          showChip(e.clientX, e.clientY, null);
          chip.innerHTML = "";
          chip.appendChild(el("div", check.reason));
        }
      } else {
        gesture.previewKey = null;
        hideChip();
      }
      return;
    }

    if (gesture.type === "link") {
      const from = portCenter(gesture.id, "out");
      ghostLayer.innerHTML = "";
      const targetId = cardUnder(e.clientX, e.clientY);
      gesture.target = null;
      gesture.badTarget = null;
      clearTargetStyles();
      if (targetId && targetId !== gesture.id) {
        const check = canReparent(config, gesture.id, targetId);
        const alreadyParent = parentPathOf(gesture.id) === targetId;
        const ok = check.ok && !alreadyParent;
        const targetEl = cards.get(targetId).el;
        if (ok) {
          gesture.target = targetId;
          targetEl.classList.add("drop-ok");
        } else {
          targetEl.classList.add("drop-bad");
          gesture.badTarget = targetId;
          gesture.badReason = alreadyParent
            ? "already a member of that pool"
            : check.reason;
        }
      }
      if (from) {
        const snap = gesture.target
          ? portCenter(gesture.target, "in")
          : null;
        const g = svgEl("path");
        g.setAttribute("class", "link-ghost");
        g.setAttribute("d", wireD(from, snap || worldPoint(e)));
        ghostLayer.appendChild(g);
      }
    }
  };

  const onPointerUp = (e) => {
    unlisten();
    const g = gesture;
    gesture = null;
    hideChip();
    clearTargetStyles();
    ghostLayer.innerHTML = "";
    if (!g) return;

    if (g.type === "move") {
      cardDragging = false;
      const c = cards.get(g.id);
      if (c) c.el.classList.remove("dragging");
      if (!g.moved) {
        if (actions.onSelect) actions.onSelect(g.id);
        drawEdges();
        return;
      }
      if (g.target) {
        if (actions.onReparent) actions.onReparent(g.id, g.target, null);
        return;
      }
      // an invalid drop reverts: parking a card on top of a target it cannot join looks like it
      // succeeded, and the reason the user just saw would be lost
      if (g.badTarget) {
        place(g.id, g.startPos);
        drawEdges();
        if (actions.onRejectDrop) actions.onRejectDrop(g.id, g.badReason);
        return;
      }
      const p = positions.get(g.id);
      if (actions.onMovePositions)
        actions.onMovePositions({ [g.id]: { x: p.x - PAD, y: p.y - PAD } });
      return;
    }

    if (g.type === "link") {
      if (!g.moved) {
        if (actions.onSelect) actions.onSelect(g.id);
        return;
      }
      if (g.target) {
        if (actions.onReparent) actions.onReparent(g.id, g.target, null);
        return;
      }
      if (g.badTarget) {
        if (actions.onRejectDrop) actions.onRejectDrop(g.id, g.badReason);
        return;
      }
      // releasing a link on empty canvas cuts it (the root has no out port, so every link drag
      // starts from a node that has a parent)
      if (actions.onCutLink) actions.onCutLink(g.id);
    }
  };

  const onPointerDown = (e) => {
    // Only the primary button drives the canvas: middle-drag pans and right-drag opens the context
    // menu, both handled by their own listeners.
    if (e.button !== 0) return;
    if (gesture) abortGesture(); // a second pointer (multitouch) must not hijack a live gesture
    // Wires are selected on pointerdown, not click: selecting on click would have to survive the
    // re-render that deselecting on empty canvas triggers between down and up, which moves the click
    // target to the canvas and loses the event entirely.
    const wire = e.target.closest(".wire-hit");
    if (wire) {
      e.preventDefault();
      if (actions.onWireClick) actions.onWireClick(wire.dataset.child);
      return;
    }
    const act = e.target.closest("[data-act]");
    if (act) {
      e.preventDefault();
      e.stopPropagation();
      const a = act.dataset.act;
      if (a === "collapse" && actions.onToggleCollapse)
        actions.onToggleCollapse(act.dataset.path);
      else if (a === "results" && actions.onOpenResults) actions.onOpenResults();
      else if (a === "tidy" && actions.onTidy) actions.onTidy();
      else if (a === "fit") fitToContent();
      else if (a === "cut" && actions.onCutLink) actions.onCutLink(act.dataset.child);
      else if (a === "count" && actions.onSetMemberCount) {
        const path = act.dataset.path;
        const slot = Number(act.dataset.slot);
        const delta = Number(act.dataset.delta);
        const m = resolvePath(config, path).members[slot];
        actions.onSetMemberCount(path, slot, (m.count || 1) + delta);
      } else if (a === "remove" && actions.onRemoveMember)
        actions.onRemoveMember(act.dataset.path, Number(act.dataset.slot));
      else if (a === "addmember" && actions.onQuickAddMember)
        actions.onQuickAddMember(act.dataset.path);
      else if (a === "select" && actions.onSelect)
        actions.onSelect(act.dataset.path);
      return;
    }

    const port = e.target.closest(".port");
    if (port && port.dataset.port === "out" && !container.classList.contains("space-pan")) {
      e.preventDefault();
      gesture = {
        type: "link",
        id: port.dataset.path,
        parentId: parentPathOf(port.dataset.path),
        startClient: { x: e.clientX, y: e.clientY },
        moved: false,
        target: null,
      };
      listen();
      return;
    }

    const card = e.target.closest(".node");
    if (!card) {
      if (actions.onSelect) actions.onSelect(null);
      return;
    }
    if (container.classList.contains("space-pan")) return;
    if (e.target.closest("input,textarea")) return;
    const id = card.dataset.id;
    const p = positions.get(id);
    if (!p) return;
    gesture = {
      type: "move",
      id,
      startClient: { x: e.clientX, y: e.clientY },
      startPos: { x: p.x, y: p.y },
      moved: false,
      target: null,
      previewKey: null,
      delta: null,
    };
    listen();
  };

  container.__dragActive = () => !!gesture;
  container.__setSelection = setSelectionInPlace;
  container.__reflow = reflow;
  container.__showPreview = (id, p) => {
    if (id !== selection) return;
    showPreview(id, p);
  };

  const onContextMenuEvent = (e) => {
    const card = e.target.closest(".node");
    if (!card) return;
    e.preventDefault();
    if (actions.onContextMenu) actions.onContextMenu(e, card.dataset.id);
  };

  edgeLayer.addEventListener("pointerover", (e) => {
    const hit = e.target.closest(".wire-hit");
    if (!hit) return;
    const ed = edges.get(hit.dataset.child);
    if (ed) addHoverCut(hit.dataset.child, ed.a, ed.b);
  });
  edgeLayer.addEventListener("pointerout", (e) => {
    if (e.target.closest(".wire-hit")) scheduleHoverCutRemoval();
  });
  // space-drag pan
  const spacePanDown = (e) => {
    if (!container.classList.contains("space-pan")) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    container.classList.add("panning");
    const move = (ev) => {
      view.x = start.vx + (ev.clientX - start.x);
      view.y = start.vy + (ev.clientY - start.y);
      applyView();
    };
    const up = () => {
      container.classList.remove("panning");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (actions.onView) actions.onView({ ...view });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // middle-drag pan
  const middlePanDown = (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    const move = (ev) => {
      view.x = start.vx + (ev.clientX - start.x);
      view.y = start.vy + (ev.clientY - start.y);
      applyView();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (actions.onView) actions.onView({ ...view });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onWheel = (e) => {
    e.preventDefault();
    const pt = canvasPoint(e);
    if (e.shiftKey) {
      view.x -= e.deltaY;
    } else {
      const next = zoomAt(view, Math.exp(-e.deltaY * 0.0015), pt.x, pt.y);
      view.x = next.x;
      view.y = next.y;
      view.zoom = next.zoom;
    }
    applyView();
    if (actions.onView) actions.onView({ ...view });
  };

  // inline editing of numeric card values
  const onDblClick = (e) => {
    const row = e.target.closest(".kv[data-editable]");
    if (!row) return;
    const card = e.target.closest(".node");
    if (!card) return;
    const id = card.dataset.id;
    const node = resolvePath(config, id);
    const key = row.dataset.key;
    const target = row.querySelector("b");
    const input = document.createElement("input");
    input.className = "inline";
    input.value = String(node[key] ?? "");
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      input.removeEventListener("blur", onBlur);
      input.replaceWith(target);
      if (commit) {
        const v = Number(input.value);
        if (Number.isFinite(v) && actions.onInlineEdit)
          actions.onInlineEdit(id, key, v);
      }
    };
    const onBlur = () => finish(true);
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") finish(true);
      if (ev.key === "Escape") finish(false);
    });
    input.addEventListener("blur", onBlur);
    input.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    target.replaceWith(input);
    input.focus();
    input.select();
    e.preventDefault();
  };

  // Every listener lives on the container, which outlives each render (only its innerHTML is
  // replaced). Registering per render would stack N copies of every handler and fire each user
  // action N times, so the handlers are published here and mounted exactly once.
  container.__ctx = {
    pointerdown: (e) => onPointerDown(e),
    contextmenu: (e) => onContextMenuEvent(e),
    wheel: (e) => onWheel(e),
    dblclick: (e) => onDblClick(e),
    spacePan: (e) => spacePanDown(e),
    middlePan: (e) => middlePanDown(e),
  };
  mountCanvas(container);

  // ---- view commands for keyboard shortcuts ------------------------------------

  function fitToContent() {
    const b = boundsOf(positions, nodeSize);
    const v = fitView(b, {
      width: container.clientWidth,
      height: container.clientHeight,
    });
    view.x = v.x;
    view.y = v.y;
    view.zoom = v.zoom;
    applyView();
    if (actions.onView) actions.onView({ ...view });
  }

  container.__view = {
    get: () => ({ ...view }),
    set: (v) => {
      view.x = v.x;
      view.y = v.y;
      view.zoom = clampZoom(v.zoom);
      applyView();
    },
    zoomBy: (factor) => {
      const next = zoomAt(
        view,
        factor,
        container.clientWidth / 2,
        container.clientHeight / 2,
      );
      view.x = next.x;
      view.y = next.y;
      view.zoom = next.zoom;
      applyView();
      if (actions.onView) actions.onView({ ...view });
    },
    fit: fitToContent,
    reset: () => {
      view.x = 40;
      view.y = 20;
      view.zoom = 1;
      applyView();
      if (actions.onView) actions.onView({ ...view });
    },
  };

  // ---- build ------------------------------------------------------------------

  // Collapsed pools hide their whole subtree: the layout tree skips those children, so a card that
  // were still drawn would get no position at all and pile up at the static origin.
  const collectVisible = (node, path, acc) => {
    acc.push(path);
    if (collapsed[path]) return acc;
    for (let i = 0; i < (node.members || []).length; i++) {
      const m = node.members[i];
      if (m.node === "pool") collectVisible(m, `${path}.members[${i}]`, acc);
    }
    return acc;
  };
  const visible = new Map();
  for (const id of collectVisible(config.tree, "tree", []))
    visible.set(id, resolvePath(config, id));
  const order = [...visible.keys()];
  for (const id of order) drawCard(id);

  // Seed from the measured heights of the previous render and only fall back to an estimate for
  // cards we have never seen. Seeding from estimates while correcting against the cache would leave
  // a warm render on stale positions whenever the estimate was off (and `reflow` saw no drift).
  const estimates = new Map(
    order.map((id) => [
      id,
      heights.get(id) ?? estimateHeight(id, config, collapsed[id]),
    ]),
  );
  const applyBaseLayout = (hMap) => {
    const computed = canvasPositions(config, { pos, collapsed, heights: hMap });
    for (const [id, xy] of computed) place(id, xy);
  };
  applyBaseLayout(estimates);
  for (const [id, p] of Object.entries(pos)) {
    if (positions.has(id) && p) place(id, { x: p.x + PAD, y: p.y + PAD });
  }
  drawEdges();

  // measure, then re-place anything the height estimate misplaced (single correction pass)
  reflow();

  applyView();
  return { heights, positions };
}
