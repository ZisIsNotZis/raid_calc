// Properties panel: context forms for the selected node, live validation, write-through.
// Every edit goes through validate() (config.js) — invalid values are rejected with an inline
// error and the config keeps its last valid state.

import { resolvePath, isPoolNode, OUTPUT_ID } from "./canvas.js";

const STRATEGY_LABELS = {
  concat: "concat (JBOD)",
  strip: "strip (D,M)",
  split: "split (N,M)",
  "strip-split": "strip-split (N,M)",
};

export function selectedNodeInfo(config, selection) {
  if (!selection) return null;
  if (selection === OUTPUT_ID) {
    return { type: "output", path: OUTPUT_ID };
  }
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

// Renders the form into `root`. `onSet` receives (mutator, label) and is expected to
// validate + commit through the store; returns true if committed.
export function renderProps(root, { config, selection, onSet, onSelect }) {
  root.innerHTML = "";
  const info = selectedNodeInfo(config, selection);
  if (!info) {
    root.innerHTML =
      '<p style="color:var(--muted);font-size:12px">Select a node to edit its properties.</p>';
    return;
  }

  const h = el(
    "h3",
    info.type === "output"
      ? "Output"
      : info.type === "kind"
        ? `Disk model · ${info.path.slice(6)}`
        : `Pool · ${info.path}`,
  );
  root.appendChild(h);
  const crumb = el(
    "div",
    info.type === "pool" ? "top-level · " + info.node.strategy : "",
  );
  crumb.className = "crumb";
  root.appendChild(crumb);

  const errorBox = el("div", "");
  errorBox.className = "form-error";
  errorBox.style.display = "none";
  root.appendChild(errorBox);

  const field = (label, { key, parse, min, unit, placeholder }) => {
    const wrap = el("div", "");
    wrap.className = "field";
    const lab = el("label", label);
    wrap.appendChild(lab);
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = placeholder ?? "";
    wrap.appendChild(input);
    const unitEl = unit ? el("span", unit) : null;
    if (unitEl) {
      unitEl.className = "unit";
      wrap.appendChild(unitEl);
    }
    const apply = (raw) => {
      let value;
      try {
        value = parse(raw);
      } catch {
        markInvalid(input, errorBox, `invalid value for ${label}`);
        return;
      }
      if (min !== undefined && value < min) {
        markInvalid(input, errorBox, `${label} must be >= ${min}`);
        return;
      }
      clearInvalid(input, errorBox);
      const ok = onSet((cfg) => setField(cfg, info, key, value), `${label}`);
      if (!ok)
        markInvalid(input, errorBox, "edit rejected — check the full config");
    };
    input.addEventListener("change", () => apply(input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") apply(input.value);
    });
    return wrap;
  };

  const select = (label, options, current, onPick) => {
    const wrap = el("div", "");
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

  if (info.type === "pool") {
    root.appendChild(
      select(
        "Strategy",
        Object.entries(STRATEGY_LABELS),
        info.node.strategy,
        (s) => {
          const ok = onSet(
            (cfg) => switchStrategy(cfg, info.path, s),
            "strategy",
          );
          if (ok) onSelect(info.path);
        },
      ),
    );
    if (info.node.strategy === "strip") {
      root.appendChild(
        field("D data members", { key: "d", parse: intParse, min: 1 }),
      );
      root.appendChild(
        field("M parity", { key: "m", parse: intParse, min: 0 }),
      );
    } else if (
      info.node.strategy === "split" ||
      info.node.strategy === "strip-split"
    ) {
      root.appendChild(
        field("N data chunks", { key: "n", parse: intParse, min: 1 }),
      );
      root.appendChild(
        field("M parity", { key: "m", parse: intParse, min: 0 }),
      );
    }
    root.appendChild(
      field("λ common-cause (/h)", {
        key: "lambdaCC",
        parse: floatParse,
        min: 0,
      }),
    );
    root.appendChild(field("Members (count → +1, ✕ → remove)", { key: null }));
    const membersWrap = el("div", "");
    membersWrap.className = "members-list";
    (info.node.members || []).forEach((m, i) => {
      const row = el("div", "");
      row.className = "member-row";
      const label = m.node === "kind" ? `${m.count}× ${m.kind}` : m.strategy;
      row.appendChild(el("span", label));
      const add = el("button", "+1");
      add.type = "button";
      add.className = "ghost tiny";
      const remove = el("button", "✕");
      remove.type = "button";
      remove.className = "ghost tiny danger";
      if (m.node === "kind") {
        add.addEventListener("click", () =>
          onSet((cfg) => bumpKindCount(cfg, info.path, i, +1), "member +1"),
        );
      }
      remove.addEventListener("click", () =>
        onSet((cfg) => removeMember(cfg, info.path, i), "remove member"),
      );
      row.appendChild(add);
      row.appendChild(remove);
      membersWrap.appendChild(row);
    });
    root.appendChild(membersWrap);
    const addMember = el("button", "+ Add member");
    addMember.type = "button";
    addMember.className = "ghost";
    addMember.addEventListener("click", () =>
      onSet((cfg) => addMemberRow(cfg, info.path), "add member"),
    );
    root.appendChild(addMember);
    return;
  }

  if (info.type === "kind") {
    root.appendChild(
      field("Capacity (TB)", {
        key: "capacityTB",
        parse: floatParse,
        min: 0.001,
      }),
    );
    root.appendChild(
      field("λ base (/h)", { key: "lambdaBase", parse: floatParse, min: 0 }),
    );
    root.appendChild(
      field("λ read (/B)", { key: "lambdaRead", parse: floatParse, min: 0 }),
    );
    root.appendChild(
      field("λ write (/B)", { key: "lambdaWrite", parse: floatParse, min: 0 }),
    );
    root.appendChild(
      field("URE (/B)", { key: "ure", parse: floatParse, min: 0 }),
    );
    root.appendChild(
      field("Read bandwidth (MB/s)", {
        key: "readBW",
        parse: mbpsParse,
        min: 0,
      }),
    );
    root.appendChild(
      field("Write bandwidth (MB/s)", {
        key: "writeBW",
        parse: mbpsParse,
        min: 0,
      }),
    );
    root.appendChild(
      field("Inventory count", { key: "count", parse: intParse, min: 1 }),
    );
    root.appendChild(
      field("Hot spares (auto)", { key: "spares", parse: intParse, min: 0 }),
    );
    return;
  }

  if (info.type === "pool") {
    // standalone preview slot (filled by main.js via .preview)
    const prev = el("h4", "Node preview (standalone)");
    const previewBox = el("div", "");
    previewBox.className = "preview";
    root.appendChild(prev);
    root.appendChild(previewBox);
  }

  if (info.type === "output") {
    const g = config.global || {};
    root.appendChild(
      field("Store ≥ (TB)", {
        key: "storeTB",
        parse: floatParse,
        min: 0.001,
        ctx: "workload",
      }),
    );
    root.appendChild(
      field("Avg read (MB/s)", {
        key: "readBps",
        parse: mbpsParse,
        min: 0,
        ctx: "workload",
      }),
    );
    root.appendChild(
      field("Avg write (MB/s)", {
        key: "writeBps",
        parse: mbpsParse,
        min: 0,
        ctx: "workload",
      }),
    );
    root.appendChild(
      field("Avg file size (MB)", {
        key: "avgFileMB",
        parse: floatParse,
        min: 0.001,
        ctx: "workload",
      }),
    );
    root.appendChild(
      field("Horizon (years)", {
        key: "horizonY",
        parse: floatParse,
        min: 0.001,
        ctx: "workload",
      }),
    );
    root.appendChild(
      field("T_op human (h)", {
        key: "tOpH",
        parse: floatParse,
        min: 0,
        ctx: "global",
      }),
    );
    root.appendChild(
      field("T_swap spare (h)", {
        key: "tSwapH",
        parse: floatParse,
        min: 0,
        ctx: "global",
      }),
    );
    root.appendChild(
      field("T_proc buy (h)", {
        key: "tProcH",
        parse: floatParse,
        min: 0,
        ctx: "global",
      }),
    );
    root.appendChild(
      field("Dedicated rebuild bw (MB/s)", {
        key: "rebuildBw",
        parse: mbpsParse,
        min: 0,
        ctx: "global",
      }),
    );
    root.appendChild(
      select(
        "Bandwidth mode",
        [
          ["true", "contended (shared with workload)"],
          ["false", "dedicated rebuildBw"],
        ],
        String(g.contention),
        (v) => {
          onSet(
            (cfg) => setGlobalBool(cfg, "contention", v === "true"),
            "contention",
          );
        },
      ),
    );
    return;
  }
}

// --- helpers ------------------------------------------------------------------

function el(tag, text) {
  const n = document.createElement(tag);
  if (text) n.textContent = text;
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
  if (info.type === "output") {
    const section = keyCtx[key] || "workload";
    return { ...cfg, [section]: { ...(cfg[section] || {}), [key]: value } };
  }
  return setPathValue(cfg, info.path, key, value);
}
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

function setPathValue(cfg, path, key, value) {
  return updateNodeAtPath(cfg, path, (node) => ({ ...node, [key]: value }));
}

// Generic: rebuild the tree with fn applied to the node at `path` (path must be under tree).
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
    if (strategy === "split" || strategy === "strip-split")
      next.n = node.n ?? 1;
    if (strategy !== "concat") next.m = node.m ?? 0;
    return next;
  });
}

function bumpKindCount(cfg, path, slot, delta) {
  return updateNodeAtPath(cfg, path, (node) => {
    const members = node.members.map((m, i) =>
      i === slot && m.node === "kind"
        ? { ...m, count: Math.max(1, (m.count ?? 1) + delta) }
        : m,
    );
    return { ...node, members };
  });
}

function removeMember(cfg, path, slot) {
  return updateNodeAtPath(cfg, path, (node) => ({
    ...node,
    members: node.members.filter((_, i) => i !== slot),
  }));
}

function addMemberRow(cfg, path) {
  const node = resolvePath(cfg, path);
  if (!isPoolNode(node)) return cfg;
  return updateNodeAtPath(cfg, path, (n) => ({
    ...n,
    members: [
      ...(n.members || []),
      { node: "pool", strategy: "concat", lambdaCC: 0, members: [] },
    ],
  }));
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
