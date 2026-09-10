// Node view-model + tree operations over the config JSON.
// Pure functions: all take the config and return a NEW config (immutable style).
// Node identity = path string: "tree" for the root pool, "tree.members[i]" for members,
// "kinds.<id>" for disk models, "output" for the virtual output node.

export const OUTPUT_ID = "output";

// --- tree walk helpers ---------------------------------------------------------

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
  if (path === OUTPUT_ID) return null; // virtual
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
  if (path === OUTPUT_ID) throw new Error("output is virtual");
  if (path.startsWith("kinds.")) {
    const id = path.slice(6);
    return { ...config, kinds: { ...config.kinds, [id]: value } };
  }
  const parts = path.split(".");
  const head = parts[0];
  if (head !== "tree") throw new Error(`cannot set path outside tree: ${path}`);
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

// --- node model ---------------------------------------------------------------

// Kind id used by a pool's kind-ref members (for the "4× HDD 8TB" summary).
export function poolKindSummary(node, kinds) {
  const counts = new Map();
  const walk = (n) => {
    if (isKindNode(n)) {
      counts.set(n.kind, (counts.get(n.kind) || 0) + n.count);
    } else if (isPoolNode(n)) {
      n.members.forEach(walk);
    }
  };
  if (node) walk(node);
  return [...counts.entries()]
    .map(([kindId, count]) => {
      const kind = kinds[kindId];
      return kind
        ? `${count}× ${kindId} ${kind.capacityTB}TB`
        : `${count}× ${kindId}`;
    })
    .join(", ");
}

// Tree-shaped view model for layout: pools and their nested pools.
// kinds appear as leaves (each distinct kind node is a leaf in the layout tree).
export function treeViewModel(config) {
  const root = config.tree;
  const toModel = (node, path) => {
    if (isKindNode(node)) {
      return { id: path, kindId: node.kind };
    }
    return {
      id: path,
      strategy: node.strategy,
      children: (node.members || []).map((m, i) =>
        toModel(m, `${path}.members[${i}]`),
      ),
    };
  };
  return toModel(root, "tree");
}

// --- connect / disconnect (all return a new config; throw on invalid) ---------

export function canBeMemberOfPool(node) {
  return isPoolNode(node) || isKindNode(node);
}

// Disk model -> pool: append a kind-ref member {node:"kind", kind, count:1}.
export function connectDiskToPool(
  config,
  kindId,
  poolPath,
  { count = 1 } = {},
) {
  const pool = resolvePath(config, poolPath);
  if (!isPoolNode(pool)) throw new Error(`not a pool: ${poolPath}`);
  if (count < 1 || !Number.isInteger(count))
    throw new Error("count must be a positive integer");
  return setPath(config, `${poolPath}.members`, [
    ...(pool.members || []),
    { node: "kind", kind: kindId, count },
  ]);
}

// Pool output -> pool member: the source pool must currently be the ROOT (a node has one
// parent). Appends the source subtree as a member of the destination pool.
export function connectPoolToPool(config, srcPath, dstPath) {
  if (srcPath === dstPath) throw new Error("cannot connect a pool to itself");
  if (srcPath !== "tree") {
    throw new Error(
      "only the root pool can be connected into another pool — move the member first (tree constraint: one parent per node)",
    );
  }
  const src = resolvePath(config, srcPath);
  const dst = resolvePath(config, dstPath);
  if (!isPoolNode(src) || !isPoolNode(dst))
    throw new Error("both endpoints must be pools");
  if (dstPath.startsWith(srcPath))
    throw new Error("cannot connect a pool into its own subtree");
  const newDstMembers = [...(dst.members || []), src];
  // moving the root into dst leaves no root: the dst becomes the root.
  const newTree = setPath(config, `${dstPath}.members`, newDstMembers);
  return { ...newTree, tree: resolvePath(newTree, dstPath) };
}

// Pool output -> output: the connected pool becomes the root (output is the root).
export function connectPoolToOutput(config, srcPath) {
  if (srcPath === "tree") return config; // already root
  const src = resolvePath(config, srcPath);
  if (!isPoolNode(src))
    throw new Error("only a pool can be connected to the output");
  // find the parent path + slot to remove it from
  const parentPath = srcPath.replace(/\.members\[\d+\]$/, "");
  const slotMatch = /members\[(\d+)\]$/.exec(srcPath);
  const slot = Number(slotMatch[1]);
  const parent = resolvePath(config, parentPath);
  const members = parent.members.slice();
  members.splice(slot, 1);
  const cfg = setPath(config, `${parentPath}.members`, members);
  return { ...cfg, tree: src };
}

// Remove a member from a pool.
export function disconnectMember(config, poolPath, slotIndex) {
  const pool = resolvePath(config, poolPath);
  if (!isPoolNode(pool)) throw new Error(`not a pool: ${poolPath}`);
  if (slotIndex < 0 || slotIndex >= (pool.members || []).length) {
    throw new Error(`slot out of range: ${slotIndex}`);
  }
  const members = pool.members.slice();
  const removed = members.splice(slotIndex, 1)[0];
  const cfg = setPath(config, `${poolPath}.members`, members);
  // if the removed node was the root's only content and the root itself was removed... the
  // root is never removed here (we only remove members, never the root). Return cfg.
  void removed;
  return cfg;
}

// Add a new empty pool as a member of `parentPath` (or as the root when parentPath === null).
export function addPool(
  config,
  { strategy = "concat", parentPath = "tree", slotIndex = null } = {},
) {
  const pool = { node: "pool", strategy, lambdaCC: 0, members: [] };
  if (strategy !== "concat") pool[strategy === "strip" ? "d" : "n"] = 1;
  if (strategy !== "concat") pool.m = 0;
  if (parentPath === null) {
    return { ...config, tree: pool };
  }
  const parent = resolvePath(config, parentPath);
  if (!isPoolNode(parent)) throw new Error(`not a pool: ${parentPath}`);
  const members = parent.members.slice();
  if (slotIndex === null) members.push(pool);
  else members.splice(slotIndex, 0, pool);
  return setPath(config, `${parentPath}.members`, members);
}

// --- DOM rendering -------------------------------------------------------------

const NODE_W = 210;

export function renderCanvas({
  container,
  config,
  selection,
  onSelect,
  onConnect,
  onLayoutRequest,
}) {
  container.innerHTML = "";
  const vm = treeViewModel(config);
  const svgNS = "http://www.w3.org/2000/svg";

  // collect all nodes to draw: disk-model nodes (one per distinct kind used + palette kinds),
  // pool nodes, and the output node.
  const kindIds = new Set(Object.keys(config.kinds));
  const usedKinds = new Set();
  walkPools(config.tree, "tree", (n) => {
    (n.members || []).forEach((m) => {
      if (m.node === "kind") usedKinds.add(m.kind);
    });
  });

  // Layout tree: output(root) -> pool hierarchy; disk models as leaves under the root too.
  const layoutTree = {
    id: "output",
    children: [{ id: "tree", children: vm.children || [] }],
  };
  for (const kindId of kindIds)
    layoutTree.children.push({ id: `kinds.${kindId}`, children: [] });
  const positions = tidyLayout(layoutTree);
  void usedKinds;

  const xScale = 40;
  const yScale = 30;
  const SX = (u) => 20 + u.x * xScale;
  const SY = (u) => 20 + u.y * yScale;

  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("class", "wires");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  container.appendChild(svg);

  const wires = document.createElementNS(svgNS, "g");
  svg.appendChild(wires);

  // helper: draw a bezier wire between two ports
  const portPos = (nodeEl) => {
    const r = nodeEl.getBoundingClientRect();
    const cr = container.getBoundingClientRect();
    return { x: r.left - cr.left, y: r.top - cr.top, w: r.width, h: r.height };
  };
  const wirePath = (from, to) => {
    const x1 = from.x + from.w,
      y1 = from.y + from.h / 2;
    const x2 = to.x,
      y2 = to.y + to.h / 2;
    const mx = (x1 + x2) / 2;
    return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
  };

  const nodesById = new Map();
  const portEls = new Map(); // path -> { el, side, type }
  let drag = null;

  const drawNode = (
    id,
    { title, badge, badgeColor, dotColor, body, kind = "pool" },
  ) => {
    const p = positions.get(id);
    if (!p) return;
    const card = document.createElement("div");
    card.className = "node" + (selection === id ? " sel" : "");
    card.style.left = SX(p) + "px";
    card.style.top = SY(p) + "px";
    card.style.width = NODE_W + "px";
    card.dataset.id = id;
    if (kind === "output") card.classList.add("out-node");

    const hd = document.createElement("div");
    hd.className = "hd";
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = dotColor;
    hd.appendChild(dot);
    const titleEl = document.createElement("span");
    titleEl.textContent = title;
    hd.appendChild(titleEl);
    if (badge) {
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = badge;
      if (badgeColor)
        b.style.cssText = `background:${badgeColor};color:var(--accent2)`;
      hd.appendChild(b);
    }
    card.appendChild(hd);
    const bd = document.createElement("div");
    bd.className = "bd";
    body(bd);
    card.appendChild(bd);

    card.addEventListener("click", () => onSelect(id));
    container.appendChild(card);
    nodesById.set(id, card);
    return card;
  };

  const addPort = (card, path, side, type) => {
    const port = document.createElement("div");
    port.className = "port " + side;
    port.dataset.path = path;
    port.dataset.type = type;
    port.dataset.side = side;
    port.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      drag = { from: { el: port, side, type, path } };
    });
    card.appendChild(port);
    portEls.set(path + ":" + side, { el: port, side, type, path });
  };

  // Disk model nodes
  for (const kindId of kindIds) {
    const kind = config.kinds[kindId];
    drawNode(`kinds.${kindId}`, {
      kind: "disk",
      title: `${kindId} ${kind.capacityTB}TB`,
      badge: "DISK",
      badgeColor: "rgba(232,180,90,.15)",
      dotColor: "var(--warn)",
      body: (bd) => {
        kv(bd, "capacity", `${kind.capacityTB} TB`);
        kv(bd, "λ base", expfmt(kind.lambdaBase) + " /h");
        kv(
          bd,
          "R/W bw",
          `${(kind.readBW / 1e6).toFixed(0)}/${(kind.writeBW / 1e6).toFixed(0)} MB/s`,
        );
        kv(bd, "spares", String(kind.spares));
      },
    });
    const card = nodesById.get(`kinds.${kindId}`);
    addPort(card, `kinds.${kindId}`, "out", "disk");
  }

  // Pool nodes
  walkPools(config.tree, "tree", (node, path) => {
    const card = drawNode(path, {
      kind: "pool",
      title: path === "tree" ? "root" : path.split(".").pop(),
      badge: node.strategy.toUpperCase(),
      badgeColor: "rgba(79,140,255,.15)",
      dotColor: "var(--accent)",
      body: (bd) => {
        kv(bd, "members", poolKindSummary(node, config.kinds) || "—");
        if (node.strategy === "strip") kv(bd, "D/M", `${node.d}+${node.m}`);
        else if (node.strategy === "split" || node.strategy === "strip-split")
          kv(bd, "N/M", `${node.n}+${node.m}`);
        kv(bd, "λcc", expfmt(node.lambdaCC) + " /h");
      },
    });
    addPort(card, path, "in", "pool");
    addPort(card, path, "out", "pool");
  });

  // Output node
  drawNode("output", {
    kind: "output",
    title: "Result",
    badge: "OUTPUT",
    badgeColor: "rgba(126,226,168,.15)",
    dotColor: "var(--accent2)",
    body: (bd) => {
      kv(
        bd,
        "usage",
        `${config.workload?.storeTB ?? 0} / ${config.workload?.storeTB ?? 0} TB`,
      );
      kv(
        bd,
        "workload",
        `${((config.workload?.readBps ?? 0) / 1e6).toFixed(0)} / ${((config.workload?.writeBps ?? 0) / 1e6).toFixed(0)} MB/s`,
      );
      kv(bd, "horizon", `${config.workload?.horizonY ?? 0} y`);
      // chart containers filled by results.renderOutputCharts (post-render hook)
      bd.dataset.chartHost = "1";
    },
  });
  const outCard = nodesById.get("output");
  addPort(outCard, "output", "in", "output");

  // wires between pool members (tree edges)
  const drawEdges = () => {
    wires.innerHTML = "";
    const drawEdge = (fromPath, toPath) => {
      const fc = nodesById.get(fromPath);
      const tc = nodesById.get(toPath);
      if (!fc || !tc) return;
      const fp = portPos(fc);
      const tp = portPos(tc);
      const pathEl = document.createElementNS(svgNS, "path");
      pathEl.setAttribute(
        "d",
        wirePath({ ...fp }, { x: tp.x, y: tp.y, h: tp.h }),
      );
      pathEl.setAttribute("fill", "none");
      pathEl.setAttribute("stroke", "var(--link)");
      pathEl.setAttribute("stroke-width", "2");
      wires.appendChild(pathEl);
    };
    // output <- root
    drawEdge("tree", "output");
    // pool member edges: parent pool output -> child pool in? Actually the tree is: root pool
    // -> member pools/kinds. We draw kind nodes -> pool edges by membership and pool->pool edges.
    walkPools(config.tree, "tree", (node, path) => {
      (node.members || []).forEach((m, i) => {
        if (m.node === "pool") drawEdge(`${path}.members[${i}]`, path);
      });
    });
    // disk models connect to every pool that references the kind (drawn once per pool)
    for (const kindId of kindIds) {
      walkPools(config.tree, "tree", (node, path) => {
        if (
          (node.members || []).some(
            (m) => m.node === "kind" && m.kind === kindId,
          )
        ) {
          drawEdge(`kinds.${kindId}`, path);
        }
      });
    }
  };
  drawEdges();

  // drag-connect
  const ghost = document.createElementNS(svgNS, "path");
  ghost.setAttribute("stroke", "var(--accent)");
  ghost.setAttribute("stroke-width", "2");
  ghost.setAttribute("fill", "none");
  ghost.style.display = "none";
  svg.appendChild(ghost);

  container.addEventListener("mousemove", (e) => {
    if (!drag) return;
    const r = container.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    ghost.style.display = "";
    ghost.setAttribute("d", `M ${mx} ${my} L ${mx + 1} ${my + 1}`);
  });
  container.addEventListener("mouseup", (e) => {
    if (!drag) return;
    const target = e.target.closest(".port");
    if (target && target !== drag.from.el) {
      const ok = onConnect(drag.from, {
        el: target,
        type: target.dataset.type,
        path: target.dataset.path,
        side: target.dataset.side,
      });
      if (!ok) {
        ghost.style.display = "none";
        drag = null;
        return;
      }
    }
    ghost.style.display = "none";
    drag = null;
  });
  container.addEventListener("mouseleave", () => {
    drag = null;
    ghost.style.display = "none";
  });
  if (onLayoutRequest) {
    const tidy = document.createElement("button");
    tidy.textContent = "Tidy";
    tidy.className = "ghost tiny float-btn";
    tidy.addEventListener("click", onLayoutRequest);
    container.appendChild(tidy);
  }
}

function kv(parent, label, value) {
  const row = document.createElement("div");
  row.className = "kv";
  const l = document.createElement("span");
  l.textContent = label;
  const v = document.createElement("b");
  v.textContent = value;
  row.appendChild(l);
  row.appendChild(v);
  parent.appendChild(row);
}

function expfmt(v) {
  if (!Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  return v.toExponential(1);
}
