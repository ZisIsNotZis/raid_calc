// Wiring: store + canvas + props + results drawer + sidebar + palette + keyboard.
//
// State lives in the config (single source of truth, ui.md §9): config.ui carries view state
// (pos / view / collapsed) and is ignored by the solver. View changes are saved without an undo
// entry and debounced; structural edits are undoable.

import { createStore, downloadConfig, readConfigFile } from "./app.js";
import {
  renderCanvas,
  resolvePath,
  isPoolNode,
  parentPathOf,
  connectDiskToPool,
  addPool,
  moveMember,
  removeNode,
  removeKind,
  setMemberCount,
  setRoot,
  setRootPlan,
  setPath,
  kindUsage,
} from "./canvas.js";
import { rekeyPositions } from "./positions.js";
import { renderProps, SCENARIO_ID } from "./props.js";
import {
  safeEvaluate,
  validationError,
  summarize,
  fmtSummary,
  previewConfig,
} from "./results.js";
import { renderChart, evaluateSeries, fmtBytes } from "./charts.js";
import { openPalette, openShortcuts, askConfirm } from "./commands.js";
import { validate, TB } from "../core/config.js";

const SAMPLE_CONFIG = {
  schemaVersion: 1,
  kinds: {
    hdd8: {
      capacityTB: 8,
      lambdaBase: 2.8e-6,
      lambdaRead: 0.9e-12,
      lambdaWrite: 1.4e-12,
      ure: 7.9e-15,
      readBW: 190e6,
      writeBW: 170e6,
      count: 13,
      spares: 1,
    },
  },
  tree: {
    node: "pool",
    strategy: "strip",
    d: 1,
    m: 1,
    lambdaCC: 0,
    members: [
      {
        node: "pool",
        strategy: "strip",
        d: 3,
        m: 1,
        lambdaCC: 1e-7,
        members: [{ node: "kind", kind: "hdd8", count: 4 }],
      },
      {
        node: "pool",
        strategy: "strip",
        d: 3,
        m: 1,
        lambdaCC: 1e-7,
        members: [{ node: "kind", kind: "hdd8", count: 4 }],
      },
    ],
  },
  global: {
    tOpH: 12,
    tSwapH: 10 / 60,
    tProcH: 48,
    rebuildBw: 150e6,
    contention: true,
  },
  workload: {
    storeTB: 20,
    readBps: 200e6,
    writeBps: 50e6,
    avgFileMB: 8,
    horizonY: 5,
  },
  ui: { pos: {}, collapsed: {}, view: { x: 60, y: 24, zoom: 1 } },
};

const CHEAP = { points: 9, stateBudget: 20000 };
const PALETTE_COLORS = [
  "var(--accent)",
  "var(--accent2)",
  "var(--warn)",
  "var(--bad)",
  "#c79bff",
];

export function createApp(rootEl, { initialConfig = SAMPLE_CONFIG } = {}) {
  const store = createStore(initialConfig);
  let selection = "tree";
  let selWire = null;
  let lastResult = null;
  let lastError = null;
  let drawerOpen = false;
  let overlays = [];
  const heights = new Map();
  const cardResults = new Map(); // path -> { fmt, series } | { error }
  const cheapCache = new Map();
  let previewTimer = null;
  let viewSaveTimer = null;

  // ---- shell ------------------------------------------------------------------

  const header = document.createElement("header");
  header.innerHTML = "<h1>◉ raid_calc</h1>";
  const undoBtn = btn("↶", "ghost");
  const redoBtn = btn("↷", "ghost");
  const resetBtn = btn("Reset example", "ghost");
  const importBtn = btn("Import", "ghost");
  const exportBtn = btn("Export", "ghost");
  const scenarioChip = btn("", "chip-btn");
  scenarioChip.title = "workload + global timings (selects the Scenario panel)";
  const helpBtn = btn("?", "ghost");
  helpBtn.title = "keyboard & gestures";
  const drawerBtn = btn("Results", "ghost");
  const runBtn = btn("▶ Run", "primary");
  const optimizeBtn = btn("✦ Auto-optimize", "magic");
  const spacer = document.createElement("div");
  spacer.className = "spacer";
  for (const b of [
    undoBtn,
    redoBtn,
    resetBtn,
    importBtn,
    exportBtn,
    spacer,
    scenarioChip,
    helpBtn,
    drawerBtn,
    runBtn,
    optimizeBtn,
  ])
    header.appendChild(b);

  const side = document.createElement("nav");
  side.className = "side";

  const canvas = document.createElement("main");
  canvas.className = "canvas";

  const props = document.createElement("aside");
  props.className = "props";

  const drawer = document.createElement("div");
  drawer.className = "drawer";
  drawer.hidden = true;

  rootEl.append(header, side, canvas, props, drawer);

  // ---- config helpers ---------------------------------------------------------

  const commit = (mutator, label, { posHints } = {}) => {
    try {
      const before = store.get();
      const next = mutator(before);
      if (!next) return false;
      let msg = "";
      try {
        validate(next);
      } catch (err) {
        msg = err.message;
      }
      const after = rekeyPositions(
        before,
        next,
        (before.ui || {}).pos || {},
        posHints,
      );
      const withUi = { ...next, ui: { ...(next.ui || before.ui || {}), pos: after } };
      store.set(() => withUi);
      setRunError(msg);
      void label;
      return true;
    } catch (err) {
      setRunError(err.message);
      toast(err.message, "bad");
      return false;
    }
  };

  const uiOf = () => store.get().ui || {};

  const commitUi = (mutator, { recordHistory = false, render = true } = {}) => {
    const nextUi = mutator(store.get().ui || {});
    store.set((cfg) => ({ ...cfg, ui: nextUi }), { recordHistory });
    if (render) renderAll();
  };

  // ---- run --------------------------------------------------------------------

  const setRunError = (msg) => {
    lastError = msg;
    runBtn.title = msg || "";
    runBtn.classList.toggle("disabled", !!msg);
  };

  const run = () => {
    const cfg = store.get();
    const err = validationError(cfg);
    if (err) {
      setRunError(err);
      toast(err, "bad");
      return false;
    }
    const { ok, result, error } = safeEvaluate(cfg);
    if (!ok) {
      setRunError(error);
      toast(error, "bad");
      return false;
    }
    lastResult = result;
    setRunError(null);
    cardResults.set("tree", cardResult(result));
    renderAll();
    return true;
  };

  const cardResult = (result) => {
    const s = summarize(result);
    return {
      fmt: fmtSummary(s),
      series: result.expectedLostBytes,
      raw: s,
    };
  };

  // ---- cheap evaluation for previews and drop deltas --------------------------

  const cheapSummary = (cfg) => {
    const { ok, result } = safeEvaluate(cfg, CHEAP);
    return ok ? summarize(result) : null;
  };

  const onPreviewDrop = (childPath, targetPath) => {
    const baseKey = "base";
    if (!cheapCache.has(baseKey)) cheapCache.set(baseKey, cheapSummary(store.get()));
    const key = `${childPath}>${targetPath}`;
    if (cheapCache.has(key)) return cheapCache.get(key);
    let delta = { ok: false };
    try {
      const cand = moveMember(store.get(), childPath, targetPath, null);
      const cs = cheapSummary(cand);
      const bs = cheapCache.get(baseKey);
      if (bs && cs) delta = { ok: true, rows: deltaRows(bs, cs) };
    } catch {
      delta = { ok: false };
    }
    cheapCache.set(key, delta);
    return delta;
  };

  const deltaRows = (b, c) => [
    {
      label: "P(any loss)",
      from: `${(b.anyLoss * 100).toFixed(2)}%`,
      to: `${(c.anyLoss * 100).toFixed(2)}%`,
      dir: dir(c.anyLoss, b.anyLoss, true),
    },
    {
      label: "E[lost]",
      from: shortBytes(b.lostBytes),
      to: shortBytes(c.lostBytes),
      dir: dir(c.lostBytes, b.lostBytes, true),
    },
    {
      label: "rebuild",
      from: `×${b.rebuildSlowdown.toFixed(2)}`,
      to: `×${c.rebuildSlowdown.toFixed(2)}`,
      dir: dir(c.rebuildSlowdown, b.rebuildSlowdown, true),
    },
    {
      label: "usable",
      from: `${(b.usableBytes / TB).toFixed(0)} TB`,
      to: `${(c.usableBytes / TB).toFixed(0)} TB`,
      dir: dir(c.usableBytes, b.usableBytes, false),
    },
  ];

  const dir = (to, from, lowerIsBetter) => {
    if (Math.abs(to - from) < 1e-12) return "";
    const better = lowerIsBetter ? to < from : to > from;
    return better ? "good" : "bad";
  };

  const shortBytes = (v) => fmtBytes(v);

  // ---- render -----------------------------------------------------------------

  const renderAll = () => {
    cheapCache.clear();
    const cfg = store.get();
    setRunError(validationError(cfg));
    renderCanvas(canvasArgs(cfg));
    renderProps(props, propsArgs());
    renderSidebar(cfg);
    renderDrawer();
    schedulePreview();
  };

  const canvasActions = () => ({
        onSelect: (id) => {
          const previous = selection;
          if (previous === id) return;
          selection = id;
          selWire = null;
          if (previous && previous !== "tree") cardResults.delete(previous);
          // Selection must not rebuild the canvas: replacing the card DOM on pointerup swallows the
          // second click of a double-click, which is how a value gets edited in place.
          if (canvas.__setSelection) canvas.__setSelection(id);
          renderProps(props, propsArgs());
          renderSidebar(store.get());
          schedulePreview();
        },
        onWireClick: (childId) => {
          selWire = childId;
          selection = null;
          renderAll();
        },
        onCutLink: (childId) => {
          selWire = null;
          commit((c) => removeNode(c, childId), "cut link");
          renderAll();
        },
        onReparent: (nodePath, targetPath, slot) => {
          commit((c) => moveMember(c, nodePath, targetPath, slot), "re-parent");
          renderAll();
        },
        onMovePositions: (patch) =>
          commitUi((ui) => ({ ...ui, pos: { ...(ui.pos || {}), ...patch } }), {
            recordHistory: true,
          }),
        onView: (view) => {
          clearTimeout(viewSaveTimer);
          viewSaveTimer = setTimeout(
            () => commitUi((ui) => ({ ...ui, view }), { render: false }),
            350,
          );
        },
        onTidy: () => commitUi((ui) => ({ ...ui, pos: {} }), { recordHistory: true }),
        onToggleCollapse: (path) =>
          commitUi(
            (ui) => ({
              ...ui,
              collapsed: { ...(ui.collapsed || {}), [path]: !(ui.collapsed || {})[path] },
            }),
            { recordHistory: true },
          ),
        onSetMemberCount: (path, slot, count) => {
          commit((c) => setMemberCount(c, path, slot, count), "member count");
          renderAll();
        },
        onRemoveMember: (path, slot) => {
          commit((c) => removeNode(c, `${path}.members[${slot}]`), "remove member");
          renderAll();
        },
        onQuickAddMember: (path) => {
          const kid = Object.keys(store.get().kinds)[0];
          commit((c) => (kid ? connectDiskToPool(c, kid, path) : addPool(c, { parentPath: path })), "add member");
          renderAll();
        },
        onPreviewDrop,
        onRejectDrop: (id, reason) => {
          toast(reason || "that drop is not allowed", "bad");
          const c = canvas.querySelector(".node.dragging");
          if (c) c.classList.remove("dragging");
          renderAll();
        },
        onOpenResults: () => toggleDrawer(true),
        onInlineEdit: (id, key, value) => {
          commit(
            (c) => setPath(c, id, { ...resolvePath(c, id), [key]: value }),
            "inline edit",
          );
          renderAll();
        },
        onContextMenu: (e, id) => openContextMenu(e, id),
  });

  const propsArgs = () => ({
    config: store.get(),
    selection,
    // A form edit changes the cards (chips, capacity) and the library, so refresh those without
    // rebuilding the form: rebuilding it would drop focus mid-edit.
    onSet: (mutator, label) => {
      const ok = commit(mutator, label);
      if (ok) {
        renderCanvasOnly();
        renderSidebar(store.get());
        // the config changed, so the standalone preview is stale
        cardResults.delete(selection);
        schedulePreview();
      }
      return ok;
    },
    // A structural edit changes the shape of the form itself (member rows, strategy fields), so the
    // panel is rebuilt on top of the canvas and sidebar refresh.
    onStructural: (mutator, label) => {
      const ok = commit(mutator, label);
      if (ok) {
        renderCanvasOnly();
        renderSidebar(store.get());
        renderProps(props, propsArgs());
        cardResults.delete(selection);
        schedulePreview();
      }
      return ok;
    },
    onPromote: (path) => promote(path),
    onDelete: (path) => deleteSelection(path),
    previewNote:
      selection && selection !== "tree" && isPoolPath(store.get(), selection)
        ? "Standalone preview shown on the card."
        : null,
  });

  // Canvas-only re-render shared by the in-place paths (selection, form edits).
  const renderCanvasOnly = () => {
    cheapCache.clear();
    renderCanvas(canvasArgs(store.get()));
  };

  const canvasArgs = (cfg) => ({
    container: canvas,
    config: cfg,
    selection,
    selWire,
    ui: cfg.ui || {},
    results: cardResults,
    heights,
    actions: canvasActions(),
  });

  const isPoolPath = (cfg, path) => isPoolNode(resolvePath(cfg, path));

  // ---- actions ----------------------------------------------------------------

  const promote = async (path) => {
    const cfg = store.get();
    const plan = setRootPlan(cfg, path);
    if (plan.kind === "noop") return;
    let wrap = false;
    if (plan.kind === "wrap") {
      const ok = await askConfirm({
        host: rootEl,
        title: "Keep the rest of the tree?",
        body:
          `Promoting this pool would leave ${plan.others} other node(s) outside the new root. ` +
          `Keep them by nesting the old root under the promoted pool (nothing is discarded), or cancel.`,
        okLabel: "Promote & keep",
      });
      if (!ok) return;
      wrap = true;
    }
    if (
      commit((c) => setRoot(c, path, { wrap }), "promote", {
        posHints: wrap ? { [path]: "tree" } : undefined,
      })
    )
      selection = "tree";
    renderAll();
  };

  const deleteSelection = (path) => {
    if (!path || path === SCENARIO_ID) return;
    if (path.startsWith("kinds.")) {
      const id = path.slice(6);
      if (commit((c) => removeKind(c, id), "delete disk model") && selection === path)
        selection = "tree";
      renderAll();
      return;
    }
    if (path === "tree") {
      toast("the root cannot be deleted — promote another pool first", "bad");
      return;
    }
    if (commit((c) => removeNode(c, path), "delete pool") && selection === path)
      selection = "tree";
    renderAll();
  };

  // Wrap `id` in a fresh concat pool that takes its place as a sibling.
  const wrapInPool = (id) => {
    if (!id || !/\.members\[\d+\]$/.test(id) || id === "tree" || id === SCENARIO_ID) {
      toast("select a pool that already sits inside another pool", "bad");
      return;
    }
    const parent = parentPathOf(id);
    const slot = Number(/members\[(\d+)\]$/.exec(id)[1]);
    commit((c) => {
      // insert the wrapper at the node's own slot (which pushes the node one slot right), then move
      // the node inside the wrapper, so the wrapper takes the node's place in the tree
      const withWrapper = addPool(c, {
        strategy: "concat",
        parentPath: parent,
        slotIndex: slot,
      });
      return moveMember(
        withWrapper,
        `${parent}.members[${slot + 1}]`,
        `${parent}.members[${slot}]`,
      );
    }, "wrap in pool");
    renderAll();
  };

  const openContextMenu = (e, id) => {
    const cfg = store.get();
    const isRoot = id === "tree";
    const menu = menuAt({ x: e.clientX, y: e.clientY }, document.body, true);
    if (!isRoot)
      menu.appendChild(
        menuItem("Set as top-level", () => promote(id)),
      );
    menu.appendChild(
      menuItem(
        (uiOf().collapsed || {})[id] ? "Expand" : "Collapse",
        () =>
          commitUi(
            (ui) => ({
              ...ui,
              collapsed: { ...(ui.collapsed || {}), [id]: !(ui.collapsed || {})[id] },
            }),
            { recordHistory: true },
          ),
      ),
    );
    menu.appendChild(
      menuItem("Add member pool", () => {
        commit((c) => addPool(c, { strategy: "concat", parentPath: id }), "add member pool");
        renderAll();
      }),
    );
    if (!isRoot)
      menu.appendChild(menuItem("Wrap in a new pool", () => wrapInPool(id)));
    menu.appendChild(
      menuItem("Copy config JSON", () => {
        const json = JSON.stringify(cfg, null, 2);
        if (navigator.clipboard) navigator.clipboard.writeText(json);
        toast("config JSON copied", "ok");
      }),
    );
    if (!isRoot)
      menu.appendChild(menuItem("Delete pool", () => deleteSelection(id), "danger"));
  };

  // ---- sidebar ----------------------------------------------------------------

  const renderSidebar = (cfg) => {
    side.innerHTML = "";

    side.appendChild(el("h3", "Build"));
    const palPool = palItem("Pool", "var(--accent)");
    palPool.addEventListener("click", () => {
      const target = isPoolPath(cfg, selection) ? selection : "tree";
      commit((c) => addPool(c, { strategy: "concat", parentPath: target }), "add pool");
      renderAll();
    });
    const palDisk = palItem("Disk model", "var(--warn)");
    palDisk.addEventListener("click", addKind);
    side.appendChild(palPool);
    side.appendChild(palDisk);

    side.appendChild(el("h3", "Disk library (drag onto a pool)"));
    const lib = el("div");
    lib.className = "library";
    for (const [id, kind] of Object.entries(cfg.kinds)) {
      const row = el("div");
      row.className = "lib-row" + (selection === `kinds.${id}` ? " sel" : "");
      const dot = el("span");
      dot.className = "dot";
      dot.style.background = "var(--warn)";
      row.appendChild(dot);
      const nm = el("div");
      nm.className = "lib-name";
      nm.appendChild(el("span", id));
      nm.appendChild(el("span", `${kind.capacityTB} TB`)).className = "lib-cap";
      row.appendChild(nm);
      const used = kindUsage(cfg, id);
      const meta = el(
        "div",
        `${used}/${kind.count} used · ${kind.spares} spare`,
      );
      meta.className = "lib-meta";
      row.appendChild(meta);
      row.addEventListener("pointerdown", (e) => startLibraryDrag(e, id));
      row.addEventListener("click", () => {
        if (suppressLibClick) {
          suppressLibClick = false;
          return;
        }
        selection = `kinds.${id}`;
        renderAll();
      });
      lib.appendChild(row);
    }
    side.appendChild(lib);

    side.appendChild(el("h3", "Inventory"));
    const inv = el("div");
    inv.className = "inventory";
    let total = 0;
    let used = 0;
    let spares = 0;
    for (const [id, kind] of Object.entries(cfg.kinds)) {
      total += kind.count;
      used += kindUsage(cfg, id);
      spares += kind.spares;
      void id;
    }
    for (const [k, v] of [
      ["disks", String(total)],
      ["referenced", String(used)],
      ["hot spares", String(spares)],
      ["free", String(Math.max(0, total - used - spares))],
    ]) {
      const row = el("div");
      row.className = "row";
      row.appendChild(el("span", k));
      row.appendChild(el("b", v));
      inv.appendChild(row);
    }
    side.appendChild(inv);

    side.appendChild(el("h3", "Results"));
    const rs = el("div");
    rs.className = "inventory";
    if (lastResult) {
      const s = fmtSummary(summarize(lastResult));
      for (const [k, v] of [
        ["E[lost] @T", s.lost],
        ["P(any loss)", s.anyLossPct],
        ["usable", s.usable],
        ["slowdown", s.slowdown],
      ]) {
        const row = el("div");
        row.className = "row";
        row.appendChild(el("span", k));
        row.appendChild(el("b", v));
        rs.appendChild(row);
      }
      const open = el("button", "Open charts");
      open.className = "ghost tiny";
      open.addEventListener("click", () => toggleDrawer(true));
      rs.appendChild(open);
    } else {
      rs.appendChild(el("div", "press Run (R)"));
    }
    side.appendChild(rs);

    const foot = el("div", "Ctrl+K commands · ? shortcuts");
    foot.className = "side-foot";
    side.appendChild(foot);
  };

  // ---- library drag -----------------------------------------------------------

  let libDrag = null;
  let suppressLibClick = false;
  const startLibraryDrag = (e, kindId) => {
    if (e.button !== 0) return;
    libDrag = { kindId, moved: false, start: { x: e.clientX, y: e.clientY } };
    const ghost = el("div", `+ ${kindId}`);
    ghost.className = "lib-ghost";
    ghost.style.display = "none";
    document.body.appendChild(ghost);
    const move = (ev) => {
      if (!libDrag) return;
      if (!libDrag.moved && Math.hypot(ev.clientX - libDrag.start.x, ev.clientY - libDrag.start.y) < 5)
        return;
      libDrag.moved = true;
      ghost.style.display = "";
      ghost.style.left = `${ev.clientX + 14}px`;
      ghost.style.top = `${ev.clientY + 12}px`;
      for (const n of canvas.querySelectorAll(".node")) n.classList.remove("drop-ok");
      const card = cardAt(ev.clientX, ev.clientY);
      if (card) card.classList.add("drop-ok");
    };
    const up = (ev) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      ghost.remove();
      const card = libDrag && libDrag.moved ? cardAt(ev.clientX, ev.clientY) : null;
      const moved = libDrag && libDrag.moved;
      libDrag = null;
      suppressLibClick = !!moved;
      for (const n of canvas.querySelectorAll(".node")) n.classList.remove("drop-ok");
      if (card && moved) {
        commit((c) => connectDiskToPool(c, kindId, card.dataset.id), "add disk member");
        renderAll();
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const cardAt = (clientX, clientY) => {
    const node = document.elementFromPoint(clientX, clientY);
    return node ? node.closest(".node") : null;
  };

  // ---- results drawer ---------------------------------------------------------

  const toggleDrawer = (open) => {
    drawerOpen = open === undefined ? !drawerOpen : open;
    renderDrawer();
  };

  const renderDrawer = () => {
    drawer.hidden = !drawerOpen;
    if (!drawerOpen) return;
    drawer.innerHTML = "";
    const head = el("div");
    head.className = "drawer-head";
    head.appendChild(el("h2", "Results"));
    const spacer2 = el("div");
    spacer2.className = "spacer";
    head.appendChild(spacer2);
    if (lastResult) {
      const pin = el("button", "Pin current");
      pin.className = "ghost tiny";
      pin.title = "keep this curve as a comparison overlay";
      pin.addEventListener("click", () => {
        overlays.push({
          label: `run ${overlays.length + 1}`,
          result: lastResult,
          color: PALETTE_COLORS[(overlays.length + 1) % PALETTE_COLORS.length],
        });
        renderDrawer();
      });
      head.appendChild(pin);
    }
    if (overlays.length) {
      const clear = el("button", "Clear pins");
      clear.className = "ghost tiny";
      clear.addEventListener("click", () => {
        overlays = [];
        renderDrawer();
      });
      head.appendChild(clear);
    }
    const close = el("button", "✕");
    close.className = "ghost tiny";
    close.addEventListener("click", () => toggleDrawer(false));
    head.appendChild(close);
    drawer.appendChild(head);

    if (!lastResult) {
      const n = el("div", "Run the evaluation to see curves here.");
      n.className = "note";
      drawer.appendChild(n);
      return;
    }
    const grid = el("div");
    grid.className = "drawer-grid";
    const mk = (label, logY, seriesFn) => {
      const wrap = el("div");
      wrap.className = "drawer-chart";
      wrap.appendChild(el("div", label)).className = "dc-title";
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      renderChart(svg, {
        width: 420,
        height: 168,
        series: seriesFn(lastResult, "var(--accent2)", "run"),
        xLabel: `${lastResult.times[lastResult.times.length - 1] / 8760} y`,
        yLabel: label,
        logY,
      });
      wrap.appendChild(svg);
      return wrap;
    };
    grid.appendChild(
      mk("E[lost](t)", true, (result, color, tag) => {
        const out = [
          {
            label: `${tag} rigorous`,
            x: result.times,
            y: evaluateSeries(result, { mode: 1, bytes: true }).y,
            color,
          },
          {
            label: `${tag} partial`,
            x: result.times,
            y: evaluateSeries(result, { mode: 2, bytes: true }).y,
            color: "var(--warn)",
            dashed: true,
          },
        ];
        overlays.forEach((o) =>
          out.push({
            label: `${o.label} rigorous`,
            x: o.result.times,
            y: evaluateSeries(o.result, { mode: 1, bytes: true }).y,
            color: o.color,
            dashed: true,
          }),
        );
        return out;
      }),
    );
    grid.appendChild(
      mk("P(any loss)(t)", false, (result, color, tag) => {
        const out = [
          { label: `${tag} P`, x: result.times, y: result.anyLossProb, color },
        ];
        overlays.forEach((o) =>
          out.push({
            label: o.label,
            x: o.result.times,
            y: o.result.anyLossProb,
            color: o.color,
            dashed: true,
          }),
        );
        return out;
      }),
    );
    const s = fmtSummary(summarize(lastResult));
    const metrics = el("div");
    metrics.className = "drawer-metrics";
    for (const [k, v] of Object.entries(s)) {
      const row = el("div");
      row.className = "row";
      row.appendChild(el("span", k));
      row.appendChild(el("b", v));
      metrics.appendChild(row);
    }
    grid.appendChild(metrics);
    drawer.appendChild(grid);
  };

  // ---- previews ---------------------------------------------------------------

  const schedulePreview = () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      if (!selection || selection === "tree" || selection === SCENARIO_ID) return;
      const cfg = store.get();
      const path = selection;
      const pcfg = previewConfig(cfg, path);
      const { ok, result, error } = safeEvaluate(pcfg, {
        stateBudget: 20000,
        points: 25,
      });
      if (!ok) {
        if (canvas.__showPreview)
          canvas.__showPreview(path, { error: error || "unsupported subtree" });
        return;
      }
      const p = cardResult(result);
      cardResults.set(path, p);
      if (canvas.__showPreview) canvas.__showPreview(path, p);
    }, 300);
  };

  // ---- toasts + menus ---------------------------------------------------------

  let toastBox = null;
  const toast = (msg, kind = "") => {
    if (!toastBox) {
      toastBox = el("div");
      toastBox.className = "toasts";
      rootEl.appendChild(toastBox);
    }
    const t = el("div", msg);
    t.className = `toast ${kind}`;
    toastBox.appendChild(t);
    setTimeout(() => t.remove(), 4200);
  };

  const menuAt = (point, host, fixed = false) => {
    const menu = el("div");
    menu.className = "menu";
    menu.style.position = fixed ? "fixed" : "absolute";
    const h = host.getBoundingClientRect();
    menu.style.left = `${fixed ? point.x : point.x - h.left}px`;
    menu.style.top = `${fixed ? point.y : point.y - h.top}px`;
    host.appendChild(menu);
    // keep the menu inside the window: a menu opened near an edge would otherwise be unclickable
    const r = menu.getBoundingClientRect();
    const overX = r.right - (window.innerWidth - 6);
    const overY = r.bottom - (window.innerHeight - 6);
    if (overX > 0) menu.style.left = `${parseFloat(menu.style.left) - overX}px`;
    if (overY > 0) menu.style.top = `${parseFloat(menu.style.top) - overY}px`;
    const close = (ev) => {
      if (menu.contains(ev.target)) return;
      menu.remove();
      window.removeEventListener("pointerdown", close);
    };
    setTimeout(() => window.addEventListener("pointerdown", close), 0);
    return menu;
  };

  const menuItem = (label, fn, cls = "") => {
    const b = el("button", label);
    b.className = `menu-item ${cls}`.trim();
    b.addEventListener("click", () => {
      b.closest(".menu").remove();
      fn();
    });
    return b;
  };

  // ---- header wiring ----------------------------------------------------------

  runBtn.addEventListener("click", run);
  drawerBtn.addEventListener("click", () => toggleDrawer());
  helpBtn.addEventListener("click", () => openShortcuts({ host: rootEl }));
  scenarioChip.addEventListener("click", () => {
    selection = SCENARIO_ID;
    renderAll();
  });
  undoBtn.addEventListener("click", () => {
    if (store.undo()) renderAll();
  });
  redoBtn.addEventListener("click", () => {
    if (store.redo()) renderAll();
  });
  resetBtn.addEventListener("click", () => {
    store.reset(structuredClone(SAMPLE_CONFIG));
    selection = "tree";
    selWire = null;
    lastResult = null;
    overlays = [];
    cardResults.clear();
    renderAll();
  });
  exportBtn.addEventListener("click", () => downloadConfig(store.get()));
  importBtn.addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        const cfg = await readConfigFile(file);
        validate(cfg);
        store.reset(cfg);
        selection = "tree";
        renderAll();
      } catch (e) {
        setRunError(e instanceof Error ? e.message : String(e));
        toast(String(e.message || e), "bad");
      }
    });
    input.click();
  });
  optimizeBtn.addEventListener("click", openOptimizer);

  const addKind = () => {
    const id = `disk${Object.keys(store.get().kinds).length + 1}`;
    commit(
      (cfg) => ({
        ...cfg,
        kinds: {
          ...cfg.kinds,
          [id]: {
            capacityTB: 8,
            lambdaBase: 2.8e-6,
            lambdaRead: 0,
            lambdaWrite: 0,
            ure: 7.9e-15,
            readBW: 190e6,
            writeBW: 170e6,
            count: 4,
            spares: 0,
          },
        },
      }),
      "add disk model",
    );
    selection = `kinds.${id}`;
    renderAll();
  };

  // ---- command palette + keyboard ---------------------------------------------

  const commands = () => [
    { label: "Add pool member to selection", run: () => {
        const target = isPoolPath(store.get(), selection) ? selection : "tree";
        commit((c) => addPool(c, { strategy: "concat", parentPath: target }), "add pool");
        renderAll();
      } },
    { label: "Add strip pool member", run: () => {
        const target = isPoolPath(store.get(), selection) ? selection : "tree";
        commit((c) => addPool(c, { strategy: "strip", parentPath: target }), "add strip pool");
        renderAll();
      } },
    { label: "Add disk model", run: addKind },
    { label: "Run evaluation", hint: "R", run },
    { label: "Auto-optimize", run: () => optimizeBtn.click() },
    { label: "Tidy canvas", hint: "T", run: () => commitUi((ui) => ({ ...ui, pos: {} }), { recordHistory: true }) },
    { label: "Fit view", hint: "F", run: () => canvas.__view && canvas.__view.fit() },
    { label: "Reset zoom", hint: "0", run: () => canvas.__view && canvas.__view.reset() },
    { label: "Toggle results drawer", hint: "G", run: () => toggleDrawer() },
    { label: "Scenario settings", run: () => { selection = SCENARIO_ID; renderAll(); } },
    { label: "Set selection as top-level", run: () => promote(selection) },
    { label: "Delete selection", hint: "Del", run: () => deleteSelection(selection) },
    { label: "Wrap selection in a new pool", run: () => wrapInPool(selection) },
    { label: "Undo", hint: "Ctrl+Z", run: () => { if (store.undo()) renderAll(); } },
    { label: "Redo", hint: "Ctrl+Shift+Z", run: () => { if (store.redo()) renderAll(); } },
    { label: "Export config", run: () => downloadConfig(store.get()) },
    { label: "Shortcuts", hint: "?", run: () => openShortcuts({ host: rootEl }) },
  ];

  const isTyping = (t) =>
    t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);

  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openPalette({ host: rootEl, commands: commands() });
      return;
    }
    if (isTyping(e.target)) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) {
        if (store.redo()) renderAll();
      } else if (store.undo()) renderAll();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
      e.preventDefault();
      if (store.redo()) renderAll();
      return;
    }
    if (e.key === " ") {
      if (!isTyping(e.target)) e.preventDefault();
      canvas.classList.add("space-pan");
      return;
    }
    if (e.key === "Escape") {
      if (canvas.__dragActive && canvas.__dragActive()) return; // the canvas aborts its own gesture
      if (document.querySelector(".modal")) document.querySelector(".modal").remove();
      else if (selWire) {
        selWire = null;
        renderAll();
      } else if (selection) {
        selection = null;
        renderAll();
      }
      return;
    }
    const k = e.key;
    if (k === "r" || k === "R") run();
    else if (k === "t" || k === "T")
      commitUi((ui) => ({ ...ui, pos: {} }), { recordHistory: true });
    else if (k === "f" || k === "F") canvas.__view && canvas.__view.fit();
    else if (k === "0") canvas.__view && canvas.__view.reset();
    else if (k === "g" || k === "G") toggleDrawer();
    else if (k === "?" || k === "/") openShortcuts({ host: rootEl });
    else if (k === "Delete" || k === "Backspace") {
      e.preventDefault();
      if (selWire) {
        const child = selWire;
        selWire = null;
        commit((c) => removeNode(c, child), "cut link");
        renderAll();
      } else deleteSelection(selection);
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === " ") canvas.classList.remove("space-pan");
  });

  // ---- optimizer modal (unchanged surface, plus Apply) ------------------------

  async function openOptimizer() {
    const cfg = store.get();
    const modal = document.createElement("div");
    modal.className = "modal";
    modal.innerHTML =
      '<div class="card"><h2>✦ Auto-optimize</h2><div class="optimizer-body">…</div></div>';
    rootEl.appendChild(modal);
    const body = modal.querySelector(".optimizer-body");
    const close = () => modal.remove();
    modal.addEventListener("click", (e) => {
      if (e.target === modal) close();
    });
    let mod;
    try {
      mod = await import("../core/optimizer.js");
    } catch {
      body.textContent = "Optimizer module unavailable.";
      body.className = "note";
      return;
    }
    if (!mod.optimize) {
      body.textContent = "Optimizer module exposes no optimize().";
      body.className = "note";
      return;
    }
    try {
      const res = await mod.optimize(cfg);
      if (!Array.isArray(res)) {
        body.textContent = "optimize() returned an unexpected shape.";
        return;
      }
      const table = document.createElement("table");
      const thead = document.createElement("tr");
      for (const h of ["#", "Design", "E[lost]", "P(loss)", "Usable", "Why", ""])
        thead.appendChild(el("th", h));
      table.appendChild(thead);
      res.slice(0, 3).forEach((d, i) => {
        const s = d.result ? fmtSummary(summarize(d.result)) : {};
        const tr = document.createElement("tr");
        if (i === 0) tr.className = "win";
        tr.appendChild(el("td", String(i + 1)));
        tr.appendChild(el("td", designLabel(d)));
        tr.appendChild(el("td", s.lost ?? "—"));
        tr.appendChild(el("td", s.anyLossPct ?? "—"));
        tr.appendChild(el("td", s.usable ?? "—"));
        const why = el("td", d.reason ?? "");
        why.className = "why";
        tr.appendChild(why);
        const apply = el("td");
        if (d.tree) {
          const b = el("button", "Apply");
          b.className = "ghost tiny";
          b.addEventListener("click", () => {
            commit((c) => ({ ...c, tree: structuredClone(d.tree) }), "apply design");
            close();
            renderAll();
          });
          apply.appendChild(b);
        }
        tr.appendChild(apply);
        table.appendChild(tr);
      });
      const foot = el("div");
      foot.className = "foot";
      const closeBtn = btn("Close", "ghost");
      closeBtn.addEventListener("click", close);
      foot.appendChild(closeBtn);
      body.textContent = "";
      body.appendChild(table);
      body.appendChild(foot);
    } catch (e) {
      const n = el("div", `optimize() failed: ${e.message || e}`);
      n.className = "note";
      body.textContent = "";
      body.appendChild(n);
    }
  }

  // ---- boot -------------------------------------------------------------------

  renderAll();
  scenarioChip.textContent = scenarioLabel(store.get());
  store.subscribe(() => {
    scenarioChip.textContent = scenarioLabel(store.get());
  });  return { store, run, getState: () => store.get(), renderAll };
}

function scenarioLabel(cfg) {
  const w = cfg.workload || {};
  return `${w.storeTB} TB · ${w.horizonY} y · ${cfg.global?.contention ? "contended" : "dedicated"}`;
}

// --- tiny DOM helpers ---------------------------------------------------------

function el(tag, text) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  return n;
}

function btn(text, cls) {
  const b = document.createElement("button");
  b.textContent = text;
  if (cls) b.className = cls;
  return b;
}

function palItem(text, color) {
  const d = document.createElement("div");
  d.className = "pal";
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.style.background = color;
  d.appendChild(dot);
  d.appendChild(el("span", text));
  return d;
}

function designLabel(d) {
  if (d && d.tree) {
    const s = d.tree.strategy || "";
    const cnt = (d.tree.members || []).length;
    return `${s} (${cnt} members)`;
  }
  return d && d.label ? String(d.label) : "design";
}

// self-bootstrap: works for both the dev page and the bundled single-file artifact.
// The instance is exposed on the root element so a browser smoke test (scripts/ux-smoke.mjs) can
// read live state instead of guessing from pixels.
if (typeof document !== "undefined" && document.getElementById("app")) {
  const root = document.getElementById("app");
  root.__app = createApp(root);
}
