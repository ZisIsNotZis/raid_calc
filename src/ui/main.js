// Wiring: store + canvas + props + results + header/sidebar + optimizer modal.

import { createStore, downloadConfig, readConfigFile } from "./app.js";
import {
  renderCanvas,
  OUTPUT_ID,
  walkPools,
  treeViewModel,
  connectDiskToPool,
  connectPoolToPool,
  connectPoolToOutput,
  addPool,
} from "./canvas.js";
import { renderProps } from "./props.js";
import {
  safeEvaluate,
  validationError,
  renderOutputCharts,
  summarize,
  fmtSummary,
  previewConfig,
} from "./results.js";
import { validate, ConfigError } from "../core/config.js";

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
};

export function createApp(rootEl, { initialConfig = SAMPLE_CONFIG } = {}) {
  const store = createStore(initialConfig);
  let selection = "tree";
  let lastResult = null;
  let lastError = null;

  // header
  const header = document.createElement("header");
  header.innerHTML = `<h1>◉ raid_calc</h1>`;
  const runBtn = btn("▶ Run", "primary");
  const optimizeBtn = btn("✦ Auto-optimize", "magic");
  const importBtn = btn("Import", "ghost");
  const exportBtn = btn("Export", "ghost");
  const undoBtn = btn("↶", "ghost");
  const redoBtn = btn("↷", "ghost");
  const resetBtn = btn("Reset example", "ghost");
  const spacer = document.createElement("div");
  spacer.className = "spacer";
  header.appendChild(undoBtn);
  header.appendChild(redoBtn);
  header.appendChild(resetBtn);
  header.appendChild(importBtn);
  header.appendChild(exportBtn);
  header.appendChild(runBtn);
  header.appendChild(optimizeBtn);

  // left sidebar
  const side = document.createElement("nav");
  side.className = "side";
  const inventory = document.createElement("div");
  inventory.className = "inventory";
  side.appendChild(el("h3", "Nodes"));
  const palDisk = palItem("Disk model", "var(--warn)");
  const palPool = palItem("Pool", "var(--accent)");
  palDisk.addEventListener("click", () => addKind());
  palPool.addEventListener("click", () => addPoolNode());
  side.appendChild(palDisk);
  side.appendChild(palPool);
  side.appendChild(el("h3", "Inventory"));
  side.appendChild(inventory);
  const resultSummary = document.createElement("div");
  resultSummary.className = "inventory";
  side.appendChild(el("h3", "Top-level result"));
  side.appendChild(resultSummary);

  // canvas
  const canvas = document.createElement("main");
  canvas.className = "canvas";

  // props
  const props = document.createElement("aside");
  props.className = "props";

  rootEl.appendChild(header);
  rootEl.appendChild(side);
  rootEl.appendChild(canvas);
  rootEl.appendChild(props);

  // ---- store wiring ----------------------------------------------------------

  // Structural edits and field edits are ALWAYS committed (the canvas must reflect what the
  // user did); an invalid config is flagged via the disabled Run button + tooltip instead of
  // silently rejected — transient invalid states are part of editing (ui.md).
  const commit = (mutator) => {
    try {
      const next = mutator(store.get());
      let msg = "";
      try {
        validate(next);
      } catch (err) {
        msg = err.message;
      }
      store.set(() => next);
      setRunError(msg);
      return true;
    } catch (err) {
      setRunError(err.message);
      return false;
    }
  };

  // ---- run -------------------------------------------------------------------

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
      return;
    }
    const { ok, result, error } = safeEvaluate(cfg);
    if (!ok) {
      setRunError(error);
      return;
    }
    lastResult = result;
    lastError = null;
    setRunError(null);
    render();
  };

  runBtn.addEventListener("click", run);

  // ---- render ----------------------------------------------------------------

  const render = () => {
    const cfg = store.get();
    const err = validationError(cfg);
    setRunError(err);
    renderCanvas({
      container: canvas,
      config: cfg,
      selection,
      onSelect: (id) => {
        selection = id;
        render();
      },
      onConnect: (from, to) => handleConnect(from, to),
      onLayoutRequest: () => render(),
    });
    if (lastResult) fillOutputCharts(canvas, lastResult);
    renderProps(props, {
      config: cfg,
      selection,
      onSet: commit,
      onSelect: (id) => {
        selection = id;
        render();
      },
    });
    renderInventory(cfg);
    renderResult(cfg);
    schedulePreview();
  };

  // ---- connect ---------------------------------------------------------------

  const handleConnect = (from, to) => {
    const fPath = from.path;
    const tPath = to.path;
    try {
      if (from.type === "disk" && to.type === "pool") {
        // disk output -> pool member input
        const kindId = fPath.slice(6);
        return commit((cfg) => connectDiskToPool(cfg, kindId, tPath));
      }
      if (from.type === "pool" && to.type === "pool") {
        return commit((cfg) => connectPoolToPool(cfg, fPath, tPath));
      }
      if (from.type === "pool" && to.type === "output") {
        return commit((cfg) => connectPoolToOutput(cfg, fPath));
      }
      setRunError("invalid connection");
      return false;
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  // ---- output node charts ----------------------------------------------------

  const fillOutputCharts = (canvasEl, result) => {
    const host = canvasEl.querySelector(".node.out-node .bd[data-chart-host]");
    if (!host) return;
    host.querySelectorAll(".out-charts").forEach((n) => n.remove());
    const wrap = el("div", "");
    wrap.className = "out-charts";
    const svgLost = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg",
    );
    svgLost.setAttribute("width", "180");
    svgLost.setAttribute("height", "64");
    const svgP = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svgP.setAttribute("width", "180");
    svgP.setAttribute("height", "64");
    wrap.appendChild(svgLost);
    wrap.appendChild(svgP);
    host.appendChild(wrap);
    renderOutputCharts({
      svgLost,
      svgP,
      result,
      xLabel: `${result.times[result.times.length - 1] / 8760} y`,
    });
  };

  // ---- inventory + add nodes -------------------------------------------------

  const addKind = () => {
    const id = `hdd${Object.keys(store.get().kinds).length + 1}`;
    commit((cfg) => ({
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
    }));
    selection = `kinds.${id}`;
    render();
  };

  const addPoolNode = () => {
    const kid = Object.keys(store.get().kinds)[0];
    commit((cfg) => {
      let next = addPool(cfg, { parentPath: "tree", strategy: "concat" });
      if (kid) {
        const lastIndex = next.tree.members.length - 1;
        next = connectDiskToPool(next, kid, `tree.members[${lastIndex}]`);
      }
      return next;
    });
    render();
  };

  const renderInventory = (cfg) => {
    inventory.innerHTML = "";
    for (const [id, kind] of Object.entries(cfg.kinds)) {
      const row = el("div", "");
      row.className = "inv";
      const r1 = el("div", "");
      r1.className = "row";
      r1.appendChild(el("span", `${id} ${kind.capacityTB}TB`));
      const num1 = el("span", `×${kind.count}`);
      num1.className = "num";
      r1.appendChild(num1);
      row.appendChild(r1);
      const sparesRow = el("div", "");
      sparesRow.className = "row sub";
      sparesRow.appendChild(el("span", "hot spares (auto)"));
      const num2 = el("span", String(kind.spares));
      num2.className = "num";
      sparesRow.appendChild(num2);
      row.appendChild(sparesRow);
      row.addEventListener("click", () => {
        selection = `kinds.${id}`;
        render();
      });
      inventory.appendChild(row);
    }
  };

  const renderResult = (cfg) => {
    if (!lastResult) return;
    const s = fmtSummary(summarize(lastResult));
    resultSummary.innerHTML = "";
    for (const [k, v] of Object.entries(s)) {
      const row = el("div", "");
      row.className = "row";
      const kEl = el(
        "span",
        k.replace(/[A-Z]/g, (c) => " " + c.toLowerCase()),
      );
      kEl.textContent = k;
      row.appendChild(kEl);
      const vEl = el("b", v);
      vEl.style.color =
        k === "lost" || k === "slowdown" ? "var(--warn)" : "var(--accent2)";
      row.appendChild(vEl);
      resultSummary.appendChild(row);
    }
    void cfg;
  };

  // ---- preview ---------------------------------------------------------------

  let previewTimer = null;
  const schedulePreview = () => {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      if (
        !selection ||
        selection === OUTPUT_ID ||
        selection === "tree" ||
        selection.startsWith("kinds.")
      )
        return;
      const cfg = store.get();
      const pcfg = previewConfig(cfg, selection);
      const { ok, result } = safeEvaluate(pcfg, { stateBudget: 20000 });
      const box = props.querySelector(".preview");
      if (!box) return;
      if (!ok) {
        const note = el(
          "div",
          `preview unavailable: ${lastError ?? "invalid"}`,
        );
        note.className = "note";
        box.textContent = "";
        box.appendChild(note);
        return;
      }
      const s = fmtSummary(summarize(result));
      const metrics = el("div", "");
      metrics.className = "mini-metrics";
      for (const [v, k] of [
        [s.lost, "E[lost]"],
        [s.anyLossPct, "P(any loss)"],
        [s.slowdown, "slowdown"],
        [s.usable, "usable"],
      ]) {
        const mm = el("div", "");
        mm.className = "mm";
        const vv = el("div", v);
        vv.className = "v";
        const kk = el("div", k);
        kk.className = "k";
        mm.appendChild(vv);
        mm.appendChild(kk);
        metrics.appendChild(mm);
      }
      box.textContent = "";
      box.appendChild(metrics);
    }, 300);
  };

  // ---- persistence -----------------------------------------------------------

  exportBtn.addEventListener("click", () => {
    downloadConfig(store.get());
  });
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
        render();
      } catch (e) {
        setRunError(e instanceof Error ? e.message : String(e));
      }
    });
    input.click();
  });
  undoBtn.addEventListener("click", () => {
    if (store.undo()) render();
  });
  redoBtn.addEventListener("click", () => {
    if (store.redo()) render();
  });
  optimizeBtn.addEventListener("click", openOptimizer);

  // ---- optimizer modal -------------------------------------------------------

  async function openOptimizer() {
    const cfg = store.get();
    const modal = document.createElement("div");
    modal.className = "modal";
    modal.innerHTML = `<div class="card"><h2>✦ Auto-optimize</h2><div class="optimizer-body">…</div></div>`;
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
      body.textContent =
        "Optimizer not available yet — it lands in ticket 10 (parallel slice).";
      body.className = "note";
      return;
    }
    if (!mod.optimize) {
      body.textContent =
        "Optimizer module loaded but exposes no optimize() — ticket 10 pending.";
      body.className = "note";
      return;
    }
    await runOptimize(mod, cfg, body);
  }

  async function runOptimize(mod, cfg, body) {
    try {
      const res = await mod.optimize(cfg);
      if (!Array.isArray(res)) {
        return `<div class="note">optimize() returned an unexpected shape (expected an array of designs).</div>`;
      }
      const table = document.createElement("table");
      const thead = document.createElement("tr");
      for (const h of [
        "#",
        "Design",
        "E[lost]",
        "P(loss)",
        "Usable",
        "Bottleneck",
      ])
        thead.appendChild(el("th", h));
      table.appendChild(thead);
      res.slice(0, 3).forEach((d, i) => {
        const s = d.result ? fmtSummary(summarize(d.result)) : {};
        const tr = document.createElement("tr");
        if (i === 0) tr.className = "win";
        tr.appendChild(el("td", String(i + 1)));
        const td = el("td", designLabel(d));
        const why = el("td", d.reason ?? "");
        why.className = "why";
        tr.appendChild(td);
        tr.appendChild(el("td", s.lost ?? "—"));
        tr.appendChild(el("td", s.anyLossPct ?? "—"));
        tr.appendChild(el("td", s.usable ?? "—"));
        tr.appendChild(why);
        table.appendChild(tr);
      });
      const foot = el("div", "");
      foot.className = "foot";
      const closeBtn = btn("Close", "ghost");
      closeBtn.addEventListener("click", () =>
        body.closest(".modal")?.remove(),
      );
      foot.appendChild(closeBtn);
      body.textContent = "";
      body.appendChild(table);
      body.appendChild(foot);
      return "";
    } catch (e) {
      const note = el(
        "div",
        `optimize() failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      note.className = "note";
      body.textContent = "";
      body.appendChild(note);
      return "";
    }
  }

  // ---- autosave + boot -------------------------------------------------------

  // Deliberately no localStorage: refresh always restores the known-good SAMPLE_CONFIG.
  // Users persist intentionally via Export/Import; Reset example provides an in-session reset.
  resetBtn.addEventListener("click", () => {
    store.reset(structuredClone(SAMPLE_CONFIG));
    selection = "tree";
    lastResult = null;
    lastError = null;
    render();
  });

  render();

  // assemble the app grid directly into the root element (#app carries the grid CSS)
  rootEl.append(header, side, canvas, props);
  return { store, getState: () => store.get(), run, selection };
}

// self-bootstrap: works for both the dev page and the bundled single-file artifact
if (typeof document !== "undefined" && document.getElementById("app")) {
  createApp(document.getElementById("app"));
}

// --- tiny DOM helpers ---------------------------------------------------------

function el(tag, text) {
  const n = document.createElement(tag);
  if (text) n.textContent = text;
  return n;
}
function btn(text, cls) {
  const b = document.createElement("button");
  b.textContent = text;
  if (cls) b.className = cls;
  return b;
}
function designLabel(d) {
  if (d && d.tree) {
    const s = d.tree.strategy || "";
    const cnt = (d.tree.members || []).length;
    return `${s} (${cnt} members)`;
  }
  return d && d.label ? String(d.label) : "design";
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
