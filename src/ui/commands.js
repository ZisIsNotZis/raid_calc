// Command palette (Ctrl+K) and the shortcut cheat-sheet overlay.
// Blender F3 muscle memory: one search box over every action the UI exposes.

export function openPalette({ host, commands, onClose, t = (x) => x }) {
  const overlay = document.createElement("div");
  overlay.className = "modal palette-modal";
  overlay.innerHTML =
    `<div class="card palette-card"><input class="palette-input" placeholder="${t("Type a command…")}" />` +
    '<div class="palette-list"></div></div>';
  host.appendChild(overlay);

  const input = overlay.querySelector(".palette-input");
  const list = overlay.querySelector(".palette-list");
  let active = 0;
  let filtered = commands.slice();

  const render = () => {
    list.innerHTML = "";
    filtered.forEach((c, i) => {
      const row = document.createElement("div");
      row.className = "palette-row" + (i === active ? " active" : "");
      const label = document.createElement("span");
      label.textContent = c.label;
      row.appendChild(label);
      if (c.hint) {
        const hint = document.createElement("kbd");
        hint.textContent = c.hint;
        row.appendChild(hint);
      }
      row.addEventListener("mouseenter", () => {
        active = i;
        render();
      });
      row.addEventListener("click", () => pick(i));
      list.appendChild(row);
    });
    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "palette-row";
      empty.textContent = t("no matching command");
      list.appendChild(empty);
    }
  };

  const close = () => {
    overlay.remove();
    if (onClose) onClose();
  };

  const pick = (i) => {
    const cmd = filtered[i];
    close();
    if (cmd && cmd.run) cmd.run();
  };

  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    filtered = commands.filter((c) => fuzzyMatch(c.label + " " + (c.keywords || ""), q));
    active = 0;
    render();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown") {
      active = Math.min(active + 1, filtered.length - 1);
      render();
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      active = Math.max(active - 1, 0);
      render();
      e.preventDefault();
    } else if (e.key === "Enter") {
      pick(active);
      e.preventDefault();
    }
  });
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });

  render();
  input.focus();
  return close;
}

// Subsequence match: "tdy" matches "tidy", "srtp" matches "set as top-level".
export function fuzzyMatch(text, query) {
  if (!query) return true;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  let i = 0;
  for (const ch of t) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return q.length === 0;
}

// Promise-based confirm dialog (window.confirm is unusable inside the single-file artifact's
// styling and cannot explain consequences).
export function askConfirm({
  host,
  title,
  body,
  okLabel = "Confirm",
  cancelLabel = "Cancel",
  t = (x) => x,
}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal";
    const card = document.createElement("div");
    card.className = "card narrow";
    const h = document.createElement("h2");
    h.textContent = title;
    card.appendChild(h);
    const p = document.createElement("p");
    p.textContent = body;
    p.className = "dialog-body";
    card.appendChild(p);
    const foot = document.createElement("div");
    foot.className = "foot";
    const cancel = document.createElement("button");
    cancel.textContent = t(cancelLabel);
    cancel.className = "ghost";
    const ok = document.createElement("button");
    ok.textContent = t(okLabel);
    const finish = (v) => {
      overlay.remove();
      resolve(v);
    };
    cancel.addEventListener("click", () => finish(false));
    ok.addEventListener("click", () => finish(true));
    foot.appendChild(cancel);
    foot.appendChild(ok);
    card.appendChild(foot);
    overlay.appendChild(card);
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) finish(false);
    });
    host.appendChild(overlay);
    ok.focus();
  });
}

const SHORTCUTS = [
  ["Ctrl+K / /", "command palette"],
  ["R", "run the evaluation"],
  ["T", "tidy the canvas (drop manual positions)"],
  ["F", "fit the view to the tree"],
  ["0", "reset zoom to 100%"],
  ["G", "toggle the results drawer"],
  ["Ctrl+Z / Ctrl+Shift+Z", "undo / redo"],
  ["Delete", "delete the selected pool, disk model, or selected wire"],
  ["Esc", "cancel a drag · close a dialog · deselect"],
  ["drag card", "move it · drop on a pool to re-parent"],
  ["drag top port", "re-link · drop on empty canvas to cancel"],
  ["click wire", "select it (hover shows ✕)"],
  ["double-click value", "edit it in place"],
  ["wheel · space+drag · middle-drag", "zoom · pan · pan"],
  ["Ctrl/⌘ + scroll", "zoom (same as wheel)"],
];

export function openShortcuts({ host, t = (x) => x }) {
  const overlay = document.createElement("div");
  overlay.className = "modal";
  const card = document.createElement("div");
  card.className = "card";
  const h = document.createElement("h2");
  h.textContent = t("Keyboard & gestures");
  card.appendChild(h);
  const list = document.createElement("div");
  list.className = "keylist";
  for (const [k, v] of SHORTCUTS) {
    const row = document.createElement("div");
    row.className = "keyrow";
    const kbd = document.createElement("kbd");
    kbd.textContent = k;
    const span = document.createElement("span");
    span.textContent = t(v);
    row.appendChild(kbd);
    row.appendChild(span);
    list.appendChild(row);
  }
  card.appendChild(list);
  const foot = document.createElement("div");
  foot.className = "foot";
  const close = document.createElement("button");
  close.textContent = t("Close");
  close.className = "ghost";
  close.addEventListener("click", () => overlay.remove());
  foot.appendChild(close);
  card.appendChild(foot);
  overlay.appendChild(card);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  host.appendChild(overlay);
}
