// Canvas view state: free positions (persisted in config.ui.pos), their survival across
// structural edits, and viewport arithmetic. Pure functions — unit-tested in tests/ui.test.js.

import { tidyLayoutSized } from "./layout.js";

export const NODE_W = 216;
export const WORLD_W = 7000;
export const WORLD_H = 4500;
export const PAD = 320; // canvas-space margin around the origin, so cards can be dragged up/left
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2;
export const FIT_MARGIN = 70;

// --- positions ----------------------------------------------------------------

// Every node object that carries an identity worth remembering a position for.
function collect(config) {
  const byNode = new WeakMap();
  const walk = (node, path) => {
    byNode.set(node, path);
    if (node.node === "pool")
      (node.members || []).forEach((m, i) =>
        walk(m, `${path}.members[${i}]`),
      );
  };
  if (config && config.tree) walk(config.tree, "tree");
  for (const [id, kind] of Object.entries((config && config.kinds) || {}))
    byNode.set(kind, `kinds.${id}`);
  return byNode;
}

function pathExists(config, path) {
  let cur = config;
  const parts = path.split(".");
  if (parts[0] === "kinds")
    return !!config.kinds && Object.hasOwn(config.kinds, parts[1]);
  if (parts[0] !== "tree") return false;
  cur = config.tree;
  for (const part of parts.slice(1)) {
    const m = /^members\[(\d+)\]$/.exec(part);
    if (m) {
      if (!cur || !cur.members || !cur.members[Number(m[1])]) return false;
      cur = cur.members[Number(m[1])];
    } else if (cur && Object.hasOwn(cur, part)) cur = cur[part];
    else return false;
  }
  return true;
}

// Carry stored positions across a structural edit. Graph operations are immutable but reuse the
// node objects they did not touch, so identity — not index — decides which position belongs to
// which node. Without this, deleting members[0] would slide members[1]'s position onto the wrong
// card (and a freshly added node would inherit it).
//
// `hints` covers the one operation that must rebuild a node on purpose (promoting a pool into a
// wrapped root): it maps an old path to the path holding the same node afterwards, and marks that
// old path as consumed so the path-based fallback cannot hand its position to a different node.
export function rekeyPositions(oldConfig, newConfig, pos, hints = {}) {
  const oldPaths = collect(oldConfig);
  const out = {};
  const consumed = new Set();
  const walk = (node, path) => {
    const from = oldPaths.get(node);
    if (from && pos[from]) {
      out[path] = pos[from];
      consumed.add(from);
    }
    if (node.node === "pool")
      (node.members || []).forEach((m, i) =>
        walk(m, `${path}.members[${i}]`),
      );
  };
  if (newConfig.tree) walk(newConfig.tree, "tree");
  for (const [id, kind] of Object.entries(newConfig.kinds || {})) {
    const from = oldPaths.get(kind);
    if (from && pos[from]) {
      out[`kinds.${id}`] = pos[from];
      consumed.add(from);
    }
  }
  for (const [from, to] of Object.entries(hints)) {
    if (pos[from]) {
      out[to] = pos[from];
      consumed.add(from);
    }
  }
  // Field edits replace a node object without moving it: its path survives, so keep its position.
  for (const [path, value] of Object.entries(pos))
    if (!(path in out) && !consumed.has(path) && pathExists(newConfig, path))
      out[path] = value;
  return out;
}

// --- layout -------------------------------------------------------------------

// Layout tree of POOL nodes only (disk kinds are library chips, not canvas nodes). Paths must use
// the TRUE member slot index, not the index within the pool-only subset — otherwise a card whose
// slot contains a kind reference gets a path that resolves to nothing and silently loses its
// position and its wire.
export function poolLayoutTree(config, collapsed = {}) {
  const toModel = (node, path) => {
    const kids =
      node.node === "pool" && !collapsed[path]
        ? (node.members || [])
            .map((m, i) => ({ m, path: `${path}.members[${i}]` }))
            .filter((e) => e.m.node === "pool")
            .map((e) => toModel(e.m, e.path))
        : [];
    return { id: path, strategy: node.strategy, children: kids };
  };
  return config.tree ? toModel(config.tree, "tree") : null;
}

// Canvas-space positions: stored drags win, everything else falls back to the tidy base layout.
export function canvasPositions(
  config,
  { pos = {}, collapsed = {}, heights = new Map() } = {},
) {
  const tree = poolLayoutTree(config, collapsed);
  const out = new Map();
  if (!tree) return out;
  const base = tidyLayoutSized(tree, {
    heightOf: (n) => heights.get(n.id) || 148,
    widthOf: () => NODE_W,
  });
  for (const [id, p] of base)
    out.set(id, { x: PAD + p.x, y: PAD + p.y });
  for (const [id, p] of Object.entries(pos))
    if (out.has(id) && p && Number.isFinite(p.x) && Number.isFinite(p.y))
      out.set(id, { x: PAD + p.x, y: PAD + p.y });
  return out;
}

export function boundsOf(positions, sizeOf) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [id, p] of positions) {
    const s = sizeOf(id) || { w: NODE_W, h: 148 };
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + s.w);
    y1 = Math.max(y1, p.y + s.h);
  }
  if (!Number.isFinite(x0)) return { x0: 0, y0: 0, x1: NODE_W, y1: 148 };
  return { x0, y0, x1, y1 };
}

// --- viewport -----------------------------------------------------------------

export const clampZoom = (z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

export function screenToWorld(view, sx, sy) {
  return { x: (sx - view.x) / view.zoom, y: (sy - view.y) / view.zoom };
}

export function worldToScreen(view, wx, wy) {
  return { x: wx * view.zoom + view.x, y: wy * view.zoom + view.y };
}

// Zoom while keeping the world point under (sx, sy) fixed on screen.
export function zoomAt(view, factor, sx, sy) {
  const zoom = clampZoom(view.zoom * factor);
  const k = zoom / view.zoom;
  return { zoom, x: sx - (sx - view.x) * k, y: sy - (sy - view.y) * k };
}

export function fitView(canvasBounds, viewport, margin = FIT_MARGIN) {
  const w = Math.max(1, canvasBounds.x1 - canvasBounds.x0);
  const h = Math.max(1, canvasBounds.y1 - canvasBounds.y0);
  const zoom = clampZoom(
    Math.min(
      (viewport.width - margin * 2) / w,
      (viewport.height - margin * 2) / h,
    ),
  );
  const cx = (canvasBounds.x0 + canvasBounds.x1) / 2;
  const cy = (canvasBounds.y0 + canvasBounds.y1) / 2;
  return {
    zoom,
    x: viewport.width / 2 - cx * zoom,
    y: viewport.height / 2 - cy * zoom,
  };
}
