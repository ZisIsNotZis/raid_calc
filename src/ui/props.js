// Properties panel: context forms for the selection, live validation, write-through.
// Every edit goes through validate() (config.js) — invalid values are reported inline and the
// config keeps the last valid state (structural edits are always committed; ui.md §6).

import {
  resolvePath,
  isPoolNode,
  isKindNode,
  reorderMember,
  removeNode,
  addPool,
  setMemberCount,
} from "./canvas.js";

const STRATEGY_LABELS = {
  concat: "concat (JBOD)",
  strip: "strip (D,M)",
  split: "split (N,M)",
  "strip-split": "strip-split (N,M)",
};

export const SCENARIO_ID = "scenario";

function selectedNodeInfo(config, selection) {
  if (!selection) return null;
  if (selection === SCENARIO_ID) return { type: "scenario", path: SCENARIO_ID };
  if (selection.startsWith("kinds.")) {
    return {
      type: "kind",
      path: selection,
      node: config.kinds[selection.slice(6)],
    };
  }
  const node = resolvePath(config, selection);
  if (!node) return null;
  return { type: isPoolNode(node) ? "pool" : "kind", path: selection, node };
}

export function renderProps(
  root,
  { config, selection, onSet, onPromote, onDelete, previewNote },
) {
  root.innerHTML = "";
  const info = selectedNodeInfo(config, selection);
  if (!info) {
    root.appendChild(el("h3", "Nothing selected"));
    root.appendChild(
      note(
        "Click a pool card to edit it. Drag a card to move or re-parent it; drag its top port to " +
          "re-link it. Drag a disk model from the library onto a pool to add a member.",
      ),
    );
    root.appendChild(el("h4", "Canvas gestures"));
    const list = el("div");
    list.className = "keylist";
    for (const [k, v] of [
      ["drag card", "move · drop on a pool to re-parent"],
      ["drag top port", "re-link · drop on empty canvas to cut"],
      ["click wire", "select · Del cuts · hover shows ✕"],
      ["double-click value", "edit in place"],
      ["wheel / space+drag", "zoom · pan"],
      ["F / 0", "fit · reset zoom"],
    ]) {
      const row = el("div");
      row.className = "keyrow";
      row.appendChild(el("kbd", k));
      row.appendChild(el("span", v));
      list.appendChild(row);
    }
    root.appendChild(list);
    root.appendChild(
      el("p", "Ctrl+K opens the command palette. ? lists every shortcut."),
    ).className = "hint";
    return;
  }

  const h = el(
    "h3",
    info.type === "scenario"
      ? "Scenario"
      : info.type === "kind"
        ? `Disk model · ${info.path.slice(6)}`
        : info.path === "tree"
          ? "Root pool (top-level)"
          : `Pool · ${info.path}`,
  );
  root.appendChild(h);
  const crumb = el(
    "div",
    info.type === "pool"
      ? info.path === "tree"
        ? `${info.node.strategy} · result of the whole config`
        : info.node.strategy
      : info.type === "kind"
        ? `referenced ${kindRefCount(config, info.path.slice(6))}× on the canvas`
        : "workload + global timings",
  );
  crumb.className = "crumb";
  root.appendChild(crumb);

  const errorBox = el("div", "");
  errorBox.className = "form-error";
  errorBox.style.display = "none";
  root.appendChild(errorBox);

  // ---- field builders ---------------------------------------------------------

  const field = (label, { key, parse, min, unit, placeholder, section }) => {
    const wrap = el("div");
    wrap.className = "field";
    wrap.appendChild(el("label", label));
    if (key === null) return wrap;
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = placeholder ?? "";
    const sec = section || keyCtx[key] || "workload";
    const raw =
      info.type === "kind"
        ? info.node[key]
        : info.type === "scenario"
          ? config[sec]?.[key]
          : info.node[key];
    const mbps = ["readBW", "writeBW", "readBps", "writeBps", "rebuildBw"].includes(
      key,
    );
    input.value =
      raw === undefined || raw === null ? "" : String(mbps ? raw / 1e6 : raw);
    wrap.appendChild(input);
    if (unit) {
      const u = el("span", unit);
      u.className = "unit";
      wrap.appendChild(u);
    }
    const apply = () => {
      let value;
      try {
        value = parse(input.value);
      } catch {
        markInvalid(input, errorBox, `invalid value for ${label}`);
        return;
      }
      if (min !== undefined && value < min) {
        markInvalid(input, errorBox, `${label} must be >= ${min}`);
        return;
      }
      clearInvalid(input, errorBox);
      const ok = onSet((cfg) => setField(cfg, info, key, value), label);
      if (!ok) markInvalid(input, errorBox, "edit rejected — check the full config");
    };
    input.addEventListener("change", apply);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") apply();
    });
    return wrap;
  };

  const select = (label, options, current, onPick) => {
    const wrap = el("div");
    wrap.className = "field";
    wrap.appendChild(el("label", label));
    const sel = document.createElement("select");
    for (const [value, text] of options) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      opt.selected = value === current;
      sel.appendChild(opt);
    }
    sel.addEventListener("change", () => onPick(sel.value));
    wrap.appendChild(sel);
    return wrap;
  };

  // ---- pool -------------------------------------------------------------------

  if (info.type === "pool") {
    root.appendChild(
      select("Strategy", Object.entries(STRATEGY_LABELS), info.node.strategy, (s) =>
        onSet((cfg) => switchStrategy(cfg, info.path, s), "strategy"),
      ),
    );
    if (info.node.strategy === "strip")
      root.appendChild(field("D data members", { key: "d", parse: intParse, min: 1 }));
    if (info.node.strategy === "strip")
      root.appendChild(field("M parity", { key: "m", parse: intParse, min: 0 }));
    if (info.node.strategy === "split" || info.node.strategy === "strip-split") {
      root.appendChild(field("N data chunks", { key: "n", parse: intParse, min: 1 }));
      root.appendChild(field("M parity", { key: "m", parse: intParse, min: 0 }));
    }
    root.appendChild(
      field("λ common-cause (/h)", { key: "lambdaCC", parse: floatParse, min: 0 }),
    );

    root.appendChild(el("h4", "Members (order matters)"));
    const list = el("div");
    list.className = "members-list";
    (info.node.members || []).forEach((m, i) => {
      const row = el("div");
      row.className = "member-row";
      row.appendChild(
        el("span", isKindNode(m) ? `${m.count}× ${m.kind}` : `${m.strategy} pool`),
      );
      const up = tiny("↑", () =>
        onSet((cfg) => reorderMember(cfg, info.path, i, -1), "reorder"),
      );
      const down = tiny("↓", () =>
        onSet((cfg) => reorderMember(cfg, info.path, i, 1), "reorder"),
      );
      up.disabled = i === 0;
      down.disabled = i === info.node.members.length - 1;
      row.appendChild(up);
      row.appendChild(down);
      if (isKindNode(m)) {
        row.appendChild(
          tiny("+1", () =>
            onSet(
              (cfg) => setMemberCount(cfg, info.path, i, (m.count ?? 1) + 1),
              "member +1",
            ),
          ),
        );
      }
      row.appendChild(
        tiny(
          "✕",
          () => onSet((cfg) => removeNode(cfg, `${info.path}.members[${i}]`), "remove member"),
          "danger",
        ),
      );
      list.appendChild(row);
    });
    root.appendChild(list);
    root.appendChild(
      tiny("+ add pool member", () =>
        onSet((cfg) => addPool(cfg, { strategy: "concat", parentPath: info.path }), "add member"),
      ),
    );

    root.appendChild(el("h4", "Actions"));
    if (info.path !== "tree")
      root.appendChild(tiny("⬆ Set as top-level", () => onPromote(info.path)));
    if (info.path !== "tree")
      root.appendChild(tiny("🗑 Delete pool", () => onDelete(info.path), "danger"));
    if (previewNote) root.appendChild(note(previewNote));
    return;
  }

  // ---- disk model -------------------------------------------------------------

  if (info.type === "kind") {
    root.appendChild(
      field("Capacity (TB)", { key: "capacityTB", parse: floatParse, min: 0.001 }),
    );
    root.appendChild(field("λ base (/h)", { key: "lambdaBase", parse: floatParse, min: 0 }));
    root.appendChild(field("λ read (/B)", { key: "lambdaRead", parse: floatParse, min: 0 }));
    root.appendChild(field("λ write (/B)", { key: "lambdaWrite", parse: floatParse, min: 0 }));
    root.appendChild(field("URE (/B)", { key: "ure", parse: floatParse, min: 0 }));
    root.appendChild(
      field("Read bandwidth (MB/s)", { key: "readBW", parse: mbpsParse, min: 0 }),
    );
    root.appendChild(
      field("Write bandwidth (MB/s)", { key: "writeBW", parse: mbpsParse, min: 0 }),
    );
    root.appendChild(field("Inventory count", { key: "count", parse: intParse, min: 1 }));
    root.appendChild(field("Hot spares (auto)", { key: "spares", parse: intParse, min: 0 }));
    root.appendChild(el("h4", "Actions"));
    root.appendChild(
      tiny("🗑 Delete disk model", () => onDelete(info.path), "danger"),
    );
    return;
  }

  // ---- scenario ---------------------------------------------------------------

  const g = config.global || {};
  root.appendChild(el("h4", "Workload"));
  root.appendChild(field("Store ≥ (TB)", { key: "storeTB", parse: floatParse, min: 0.001 }));
  root.appendChild(field("Avg read (MB/s)", { key: "readBps", parse: mbpsParse, min: 0 }));
  root.appendChild(field("Avg write (MB/s)", { key: "writeBps", parse: mbpsParse, min: 0 }));
  root.appendChild(
    field("Avg file size (MB)", { key: "avgFileMB", parse: floatParse, min: 0.001 }),
  );
  root.appendChild(
    field("Horizon (years)", { key: "horizonY", parse: floatParse, min: 0.001 }),
  );
  root.appendChild(el("h4", "Global"));
  root.appendChild(field("T_op human (h)", { key: "tOpH", parse: floatParse, min: 0 }));
  root.appendChild(field("T_swap spare (h)", { key: "tSwapH", parse: floatParse, min: 0 }));
  root.appendChild(field("T_proc buy (h)", { key: "tProcH", parse: floatParse, min: 0 }));
  root.appendChild(
    field("Dedicated rebuild bw (MB/s)", { key: "rebuildBw", parse: mbpsParse, min: 0 }),
  );
  root.appendChild(
    select(
      "Bandwidth mode",
      [
        ["true", "contended (shared with workload)"],
        ["false", "dedicated rebuildBw"],
      ],
      String(g.contention),
      (v) =>
        onSet((cfg) => setGlobalBool(cfg, "contention", v === "true"), "contention"),
    ),
  );
}

// --- helpers ------------------------------------------------------------------

function el(tag, text) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  return n;
}

function note(text) {
  const n = el("div", text);
  n.className = "note";
  return n;
}

function tiny(label, fn, cls = "") {
  const b = el("button", label);
  b.type = "button";
  b.className = `ghost tiny ${cls}`.trim();
  b.addEventListener("click", fn);
  return b;
}

function kindRefCount(config, kindId) {
  let n = 0;
  const walk = (node) => {
    if (!node) return;
    if (node.node === "kind" && node.kind === kindId) n += node.count;
    else (node.members || []).forEach(walk);
  };
  walk(config.tree);
  return n;
}

const floatParse = (s) => {
  const v = Number(s);
  if (!Number.isFinite(v)) throw new Error("number expected");
  return v;
};
const intParse = (s) => {
  const v = Number(s);
  if (!Number.isInteger(v)) throw new Error("integer expected");
  return v;
};
const mbpsParse = (s) => Number(s) * 1e6;

const keyCtx = {
  storeTB: "workload",
  readBps: "workload",
  writeBps: "workload",
  avgFileMB: "workload",
  horizonY: "workload",
  tOpH: "global",
  tSwapH: "global",
  tProcH: "global",
  rebuildBw: "global",
};

function setField(cfg, info, key, value) {
  if (info.type === "kind") {
    return {
      ...cfg,
      kinds: {
        ...cfg.kinds,
        [info.path.slice(6)]: { ...info.node, [key]: value },
      },
    };
  }
  const section = keyCtx[key] || "workload";
  return { ...cfg, [section]: { ...(cfg[section] || {}), [key]: value } };
}

function updateNodeAtPath(cfg, path, fn) {
  if (!path || path === "tree") return { ...cfg, tree: fn(cfg.tree) };
  const parts = path.split(".");
  const setIn = (node, idx) => {
    const part = parts[idx];
    const m = /^members\[(\d+)\]$/.exec(part);
    if (m) {
      const members = node.members.slice();
      members[Number(m[1])] = setIn(members[Number(m[1])], idx + 1);
      return { ...node, members };
    }
    if (idx === parts.length - 1) return fn(node);
    return { ...node, [part]: setIn(node[part], idx + 1) };
  };
  return { ...cfg, tree: setIn(cfg.tree, 1) };
}

function switchStrategy(cfg, path, strategy) {
  return updateNodeAtPath(cfg, path, (node) => {
    const next = {
      node: "pool",
      strategy,
      lambdaCC: node.lambdaCC ?? 0,
      members: node.members ?? [],
    };
    if (strategy === "strip") next.d = node.d ?? 1;
    if (strategy === "split" || strategy === "strip-split") next.n = node.n ?? 1;
    if (strategy !== "concat") next.m = node.m ?? 0;
    return next;
  });
}

function setGlobalBool(cfg, key, value) {
  return { ...cfg, global: { ...(cfg.global || {}), [key]: value } };
}

function markInvalid(input, errorBox, msg) {
  input.classList.add("invalid");
  errorBox.textContent = msg;
  errorBox.style.display = "block";
}
function clearInvalid(input, errorBox) {
  input.classList.remove("invalid");
  errorBox.textContent = "";
  errorBox.style.display = "none";
}
