// Browser smoke test for the canvas (ticket 14 + 15). Drives the real bundle with real pointer
// gestures, asserts the observable DOM *and* the live config, and writes evidence screenshots.
//
//   node scripts/ux-smoke.mjs [path/to/raid-calc.html]
//
// Exit code 1 if any check fails or the page logs an error. Checks run in a deliberate order:
// pristine-config assertions first (curves, previews, creation), then interactions, then the
// destructive ones, and chrome (language/theme) last — a check must not be blamed for a config an
// earlier step legitimately broke.

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const target = resolve(process.argv[2] || resolve(root, "raid-calc.html"));
const evidence = resolve(root, ".scratch/01-raid-calc/evidence");
mkdirSync(evidence, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

function executablePath() {
  const base = resolve(homedir(), ".cache/ms-playwright");
  if (!existsSync(base)) return undefined;
  for (const d of readdirSync(base).filter((x) => x.startsWith("chromium-"))) {
    for (const sub of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
      const p = resolve(base, d, sub);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

const browser = await chromium.launch({
  executablePath: executablePath(),
  args: ["--allow-file-access-from-files", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) =>
  errors.push(String(e.stack || e).split("\n").slice(0, 2).join(" | ")),
);

// --- helpers ------------------------------------------------------------------------------------

const box = async (sel) => {
  const b = await page.locator(sel).first().boundingBox();
  if (!b) throw new Error(`no bounding box for ${sel}`);
  return b;
};
const center = async (sel) => {
  const b = await box(sel);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
const drag = async (from, to, steps = 12) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++)
    await page.mouse.move(
      from.x + ((to.x - from.x) * i) / steps,
      from.y + ((to.y - from.y) * i) / steps,
    );
  await page.mouse.up();
};
const styleOf = (sel) =>
  page.locator(sel).first().evaluate((n) => `${n.style.left},${n.style.top}`);
const state = () => page.evaluate(() => document.getElementById("app").__app.getState());
const poolPaths = () =>
  page.evaluate(() => [...document.querySelectorAll(".node")].map((n) => n.dataset.id));
const validConfig = () =>
  page.evaluate(() => !document.querySelector("header button.disabled"));
const runWhy = () => page.evaluate(() => document.querySelector("header button.disabled")?.title || "");
// first card that is not the root, and the first card that is at least two levels deep
const anyChild = () =>
  page.evaluate(
    () => [...document.querySelectorAll(".node")].find((n) => !n.classList.contains("root"))?.dataset.id || null,
  );
const deepCard = () =>
  page.evaluate(
    () =>
      [...document.querySelectorAll(".node")]
        .map((n) => n.dataset.id)
        .find((id) => (id.match(/\.members\[/g) || []).length >= 2) || null,
  );
// A card whose own header really is the topmost element at its centre — overlapping cards (free
// positions, wrappers) would otherwise swallow synthetic clicks aimed at them.
const visibleCard = (predicate = () => true) =>
  page.evaluate((src) => {
    // the predicate is passed as source: `new Function` needs an explicit return, otherwise the
    // body just evaluates the arrow and yields undefined (every card skipped)
    const fn = new Function("id", "root", `return (${src})(id, root);`);
    for (const n of document.querySelectorAll(".node")) {
      if (!fn(n.dataset.id, n.classList.contains("root"))) continue;
      const r = n.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + 12);
      if (hit && n.contains(hit)) return n.dataset.id;
    }
    return null;
  }, predicate.toString());

// a point on empty canvas (no card within 24px)
const emptyPoint = () =>
  page.evaluate(() => {
    const rects = [...document.querySelectorAll(".node")].map((n) => n.getBoundingClientRect());
    const cv = document.querySelector(".canvas").getBoundingClientRect();
    for (let y = cv.y + 40; y < cv.bottom - 60; y += 40)
      for (let x = cv.right - 60; x > cv.x + 60; x -= 60)
        if (!rects.some((r) => x > r.x - 24 && x < r.right + 24 && y > r.y - 24 && y < r.bottom + 24))
          return { x, y };
    return null;
  });
// a point that really is on the first wire and really is the topmost element there
const wirePoint = () =>
  page.evaluate(() => {
    const hit = document.querySelector(".wire-hit");
    if (!hit) return { ok: false, under: "no .wire-hit in the DOM" };
    const m = hit.getScreenCTM();
    const len = hit.getTotalLength();
    const seen = new Set();
    for (let t = 0; t <= 1.0001; t += 0.02) {
      const p = hit.getPointAtLength(len * t);
      const x = m.a * p.x + m.c * p.y + m.e;
      const y = m.b * p.x + m.d * p.y + m.f;
      const e = document.elementFromPoint(x, y);
      const under = e ? `${e.tagName}.${e.getAttribute("class") || ""}` : "none";
      seen.add(under);
      if (e && e.classList && e.classList.contains("wire-hit")) return { x, y, ok: true, under };
    }
    return { ok: false, under: `saw ${[...seen].join(", ")}` };
  });
const cardRects = () =>
  page.evaluate(() =>
    [...document.querySelectorAll(".node")]
      .map((n) => {
        const r = n.getBoundingClientRect();
        return `${n.dataset.id} ${r.x | 0},${r.y | 0} ${r.height | 0}h`;
      })
      .join(" | "),
  );
// the pool a create action just made: its card, its stored position and the config validity
const lastCreated = async (point) => {
  const id = await page.evaluate(() => document.querySelector(".node.sel")?.dataset.id || null);
  if (!id) return { id: null };
  const info = await page.evaluate((sel) => {
    const st = document.getElementById("app").__app.getState();
    const card = document.querySelector(`[data-id="${sel}"]`);
    const r = card && card.getBoundingClientRect();
    return {
      stored: (st.ui.pos || {})[sel] || null,
      topLeft: r ? { x: r.x, y: r.y } : null,
    };
  }, id);
  const disabled = await page.evaluate(() => !!document.querySelector("header button.disabled"));
  return {
    id,
    ...info,
    disabled,
    why: await runWhy(),
    dist: info.topLeft ? Math.hypot(info.topLeft.x - point.x, info.topLeft.y - point.y) : Infinity,
  };
};
// Each section starts from the known-good example config: sections are independent scenarios, and a
// later check must never be blamed for a structural mess an earlier destructive step created.
const resetExample = async () => {
  await page.locator("header button", { hasText: "Reset example" }).click();
  await page.waitForSelector(".node.root", { timeout: 5000 });
  await page.waitForTimeout(120);
};

// Tidy + Fit through the HUD buttons: the keyboard shortcuts are deliberately ignored while a form
// field has focus, which would silently skip the normalisation.
const tidyAndFit = async () => {
  await page.locator('button[data-act="tidy"]').click();
  await page.locator('button[data-act="fit"]').click();
  await page.waitForTimeout(150);
};

const step = async (name, fn) => {
  try {
    const r = await fn();
    check(name, r.ok, r.detail);
  } catch (e) {
    check(name, false, `threw: ${String(e.message).split("\n")[0]}`);
  }
};

await page.goto(`file://${target}`);
await page.waitForSelector(".node.root", { timeout: 15000 });

// =================================================================================================
// 1. pristine config: structure, run, curves, previews, creation
// =================================================================================================

await step("root card exists and is labelled top-level", async () => ({
  ok: (await page.locator(".node.root .badge").first().textContent()) === "TOP-LEVEL",
}));
await step("the config has no output node and the root is the top-level pool", async () => {
  const s = await state();
  return { ok: s.tree.node === "pool" && !("output" in s), detail: Object.keys(s).join(",") };
});
await step("canvas holds exactly one card per pool node", async () => {
  const s = await state();
  let pools = 0;
  const walk = (n) => {
    pools++;
    (n.members || []).forEach((m) => m.node === "pool" && walk(m));
  };
  walk(s.tree);
  const cards = await poolPaths();
  return { ok: cards.length === pools && pools === 3, detail: `${cards.length} cards / ${pools} pools` };
});
await step("disk kinds are library rows, never canvas cards", async () => ({
  ok:
    (await page.locator(".lib-row").count()) === 1 &&
    (await page.locator(".node .badge", { hasText: "DISK" }).count()) === 0,
}));
await step("a wire is drawn for every pool child", async () => ({
  ok: (await page.locator(".wire").count()) === (await poolPaths()).length - 1,
}));
await step("minimap sits in the bottom-right corner of the canvas", async () => {
  const mm = await box(".minimap");
  const cv = await box(".canvas");
  return {
    ok: mm.x + mm.width > cv.x + cv.width - 40 && mm.y + mm.height > cv.y + cv.height - 40,
    detail: `minimap@${mm.x | 0},${mm.y | 0}`,
  };
});
await page.screenshot({ path: resolve(evidence, "ux-01-initial.png") });

await step("Run fills the root ribbon", async () => {
  await page.keyboard.press("r");
  await page.waitForSelector(".node.root .rb-v", { timeout: 180000 });
  return { ok: true, detail: await page.locator(".node.root .rb-v").first().textContent() };
});
await step("the ribbon opens the results drawer with both charts", async () => {
  await page.locator(".node.root .ribbon").click();
  await page.waitForSelector(".drawer .drawer-chart svg", { timeout: 5000 });
  return {
    ok: (await page.locator(".drawer").isVisible()) && (await page.locator(".drawer .drawer-chart svg").count()) === 2,
  };
});
await page.screenshot({ path: resolve(evidence, "ux-02-run-drawer.png") });
await step("a curve can be pinned as an overlay", async () => {
  await page.locator(".drawer-head button", { hasText: "Pin current" }).click();
  return { ok: (await page.locator(".drawer-head button", { hasText: "Clear pins" }).count()) === 1 };
});
await page.keyboard.press("g");

await step("every pool card shows its own curve", async () => {
  const cards = await poolPaths();
  await page.waitForTimeout(900);
  const withCurve = await page.evaluate(
    () =>
      [...document.querySelectorAll(".node:not(.root)")].filter((n) =>
        n.querySelector(".node-curve svg path"),
      ).length,
  );
  return {
    ok: withCurve === cards.length - 1 && withCurve > 0,
    detail: `${withCurve} of ${cards.length - 1} non-root cards`,
  };
});

await step("the selected card shows a preview popover that does not disturb layout", async () => {
  await page.locator('[data-id="tree.members[0]"] .hd').click();
  const before = await styleOf('[data-id="tree.members[0]"]');
  let text = null;
  for (let i = 0; i < 40 && text === null; i++) {
    text = await page.evaluate(() => {
      const p = document.querySelector(".preview-pop");
      return p && !p.hidden && p.querySelector(".np-row") ? p.textContent : null;
    });
    if (text === null) await page.waitForTimeout(250);
  }
  const after = await styleOf('[data-id="tree.members[0]"]');
  return {
    ok: !!text && /E\[lost\]/.test(text) && before === after,
    detail: text ? text.replace(/\s+/g, " ").trim().slice(0, 56) : "no popover",
  };
});

// ---- creation from the library, the palette and empty canvas (config is still pristine) --------

await step("dragging the sidebar Pool item onto empty canvas creates a pool there", async () => {
  const before = await poolPaths();
  const point = await emptyPoint();
  if (!point) return { ok: false, detail: "no empty canvas area" };
  await drag(await center('.pal:has-text("Pool")'), point);
  const after = await poolPaths();
  const made = await lastCreated(point);
  return {
    ok: !!made.id && made.dist < 30 && after.length > before.length && !made.disabled,
    detail: `${before.length} → ${after.length} pools at ${made.id}, ${made.dist.toFixed(0)}px, valid=${!made.disabled}`,
  };
});

await step("dragging a disk onto empty canvas creates a seeded pool at that point", async () => {
  const before = await poolPaths();
  const point = await emptyPoint();
  if (!point) return { ok: false, detail: "no empty canvas area" };
  await drag(await center(".lib-row"), point);
  const after = await poolPaths();
  const made = await lastCreated(point);
  return {
    ok: !!made.id && made.dist < 30 && after.length > before.length && !made.disabled && !!made.stored,
    detail: `${before.length} → ${after.length} pools at ${made.id}, ${made.dist.toFixed(0)}px from the drop, valid=${!made.disabled}`,
  };
});

await step("double-clicking empty canvas creates a pool there", async () => {
  const before = await poolPaths();
  const point = await emptyPoint();
  if (!point) return { ok: false, detail: "no empty canvas area" };
  await page.mouse.dblclick(point.x, point.y);
  const after = await poolPaths();
  const made = await lastCreated(point);
  return {
    ok: !!made.id && made.dist < 30 && after.length > before.length && !made.disabled,
    detail: `${before.length} → ${after.length} pools, ${made.dist.toFixed(0)}px from the drop, valid=${!made.disabled}`,
  };
});

await step("creating next to exact-slot pools keeps every member count exact", async () => {
  const cfg = await state();
  const exact = [];
  // a member array entry is not a slot: a kind ref stands for `count` slots
  const slotsOf = (n) =>
    (n.members || []).reduce((a, m) => a + (m.node === "kind" ? m.count : 1), 0);
  const walk = (n, path) => {
    if (n.node !== "pool") return;
    exact.push({
      path,
      strategy: n.strategy,
      slots: slotsOf(n),
      want: n.strategy === "strip" ? n.d + n.m : n.strategy === "concat" ? null : n.n + n.m,
    });
    (n.members || []).forEach((m, i) => m.node === "pool" && walk(m, `${path}.members[${i}]`));
  };
  walk(cfg.tree, "tree");
  const bad = exact.filter((p) => p.want !== null && p.slots !== p.want);
  const valid = await validConfig();
  return {
    ok: valid && bad.length === 0,
    detail: bad.length ? JSON.stringify(bad) : `${exact.length} pools, all exact counts hold`,
  };
});

// =================================================================================================
// 2. canvas interactions (pristine config again)
// =================================================================================================
await resetExample();

await step("no text gets selected while dragging a card", async () => {
  await page.evaluate(() => window.getSelection().removeAllRanges());
  const child = await anyChild();
  const c = await center(`[data-id="${child}"] .hd`);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 60, c.y + 40);
  await page.mouse.move(c.x + 130, c.y + 90);
  const during = await page.evaluate(() => String(window.getSelection() || ""));
  await page.mouse.up();
  return { ok: during === "", detail: `selection: "${during}"` };
});
await step("the canvas is marked user-select: none", async () => ({
  ok: (await page.evaluate(() => getComputedStyle(document.querySelector(".canvas")).userSelect)) === "none",
}));

await step("dragging empty canvas pans the view without moving a card", async () => {
  const before = await page.evaluate(() => document.querySelector(".world").style.transform);
  const cardBefore = await styleOf(`[data-id="${await anyChild()}"]`);
  const zoomBefore = await page.locator(".zoom-label").textContent();
  const point = await emptyPoint();
  if (!point) return { ok: false, detail: "no empty canvas area" };
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x - 90, point.y + 40);
  await page.mouse.move(point.x - 150, point.y + 80);
  const during = await page.evaluate(() => document.querySelector(".world").style.transform);
  await page.mouse.up();
  const cardAfter = await styleOf(`[data-id="${await anyChild()}"]`);
  const zoomAfter = await page.locator(".zoom-label").textContent();
  return {
    ok: before !== during && cardBefore === cardAfter && zoomBefore === zoomAfter,
    detail: `${before} → ${during} (zoom ${zoomBefore}→${zoomAfter})`,
  };
});

await step("cards are draggable and keep a free position", async () => {
  const before = await styleOf(".node.root");
  const c = await center(".node.root .hd");
  await drag(c, { x: c.x + 200, y: c.y - 70 });
  const after = await styleOf(".node.root");
  return { ok: before !== after, detail: `${before} → ${after}` };
});
await step("Tidy forgets manual positions and re-runs the auto layout", async () => {
  const before = await styleOf(".node.root");
  await page.locator('button[data-act="tidy"]').click();
  const after = await styleOf(".node.root");
  const stored = (await state()).ui.pos;
  return {
    ok: before !== after && Object.keys(stored).length === 0,
    detail: `${before} → ${after}`,
  };
});
await step("Escape cancels a drag and nothing is committed", async () => {
  const c = await center(".node.root .hd");
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 160, c.y + 120);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  return { ok: Object.keys((await state()).ui.pos).length === 0 };
});

await step("dropping a card on a pool re-parents it", async () => {
  // two SIBLING pools: dragging one onto the other must nest it (dropping it back on its own
  // parent would be a no-op that looks like success)
  const siblings = await page.evaluate(() =>
    [...document.querySelectorAll(".node")]
      .map((n) => n.dataset.id)
      .filter((id) => /^tree\.members\[\d+\]$/.test(id)),
  );
  if (siblings.length < 2) return { ok: false, detail: `need two siblings, have ${siblings.length}` };
  const [child, other] = siblings;
  const target0 = await center(`[data-id="${other}"]`);
  const src = await center(`[data-id="${child}"] .hd`);
  await page.mouse.move(src.x, src.y);
  await page.mouse.down();
  await page.mouse.move(src.x - 40, src.y - 30);
  await page.mouse.move(target0.x, target0.y);
  const highlighted = await page
    .locator(`[data-id="${other}"]`)
    .first()
    .evaluate((n) => n.classList.contains("drop-ok"));
  await page.mouse.up();
  // the target's own path shifts when the moved sibling leaves the array, so assert on the shape
  const shape = await page.evaluate(() => {
    const st = document.getElementById("app").__app.getState();
    let nested = 0;
    const walk = (n) => {
      if ((n.members || []).some((m) => m.node === "pool")) nested++;
      (n.members || []).forEach((m) => m.node === "pool" && walk(m));
    };
    walk(st.tree);
    return nested;
  });
  const deep = await deepCard();
  return {
    ok: highlighted && shape > 0 && !!deep,
    detail: `${child} → ${other}; pools with a pool member: ${shape}, depth-2 card: ${deep}`,
  };
});
await page.screenshot({ path: resolve(evidence, "ux-03-reparented.png") });

await step("a collapsed pool hides its whole subtree", async () => {
  const id = await page.evaluate(
    () =>
      [...document.querySelectorAll(".node")]
        .find((n) => n.querySelector(".chips .chip.pool"))?.dataset.id || null,
  );
  if (!id) return { ok: false, detail: "no card with a pool member" };
  const before = (await poolPaths()).length;
  await page.locator(`[data-id="${id}"] .chev`).click();
  const after = (await poolPaths()).length;
  await page.locator(`[data-id="${id}"] .chev`).click();
  return { ok: after < before, detail: `${before} → ${after} cards` };
});

await step("clicking a nested card shows its form", async () => {
  const deep = (await deepCard()) || (await anyChild());
  if (!deep) return { ok: false, detail: "no non-root card" };
  await page.locator(`[data-id="${deep}"] .hd`).click();
  await page.waitForSelector(".props h3", { timeout: 3000 });
  return { ok: (await page.locator(".props h3").textContent()).startsWith("Pool") };
});
await step("editing a nested pool's fields writes to the pool, not the scenario", async () => {
  const deep = (await deepCard()) || (await anyChild());
  if (!deep) return { ok: false, detail: "no non-root card" };
  const field = page.locator(".props .field", { hasText: "λ common-cause" }).locator("input");
  await field.fill("0.004");
  await field.press("Enter");
  const s = await state();
  const node = await page.evaluate(
    (id) => {
      let n = document.getElementById("app").__app.getState().tree;
      for (const part of id.split(".").slice(1)) {
        const m = /^members\[(\d+)\]$/.exec(part);
        n = m ? n.members[Number(m[1])] : n[part];
      }
      return n;
    },
    deep,
  );
  return {
    ok: node.lambdaCC === 0.004 && s.workload.lambdaCC === undefined,
    detail: `pool=${node.lambdaCC}, workload=${s.workload.lambdaCC}`,
  };
});
await step("the ✕ on a member chip removes exactly one member", async () => {
  await page.keyboard.press("t");
  await page.keyboard.press("f");
  await page.waitForTimeout(150);
  const deep =
    (await visibleCard(
      (x) =>
        !x.startsWith("tree.") &&
        !!document.querySelector(`[data-id="${x}"] .chip.kind .rm`),
    )) ||
    (await visibleCard((x) => !!document.querySelector(`[data-id="${x}"] .chip.kind .rm`)));
  if (!deep) return { ok: false, detail: "no card with a removable kind chip" };
  const before = await page.locator(`[data-id="${deep}"] .chip`).count();
  await page.locator(`[data-id="${deep}"] .chip.kind .rm`).first().click({ force: true });
  const after = await page.locator(`[data-id="${deep}"] .chip`).count();
  return { ok: after === before - 1, detail: `${before} → ${after} chips` };
});
await step("a library drag adds a disk member to the pool under the cursor", async () => {
  await tidyAndFit();
  const id = (await visibleCard((x) => !x.startsWith("tree."))) || (await visibleCard());
  if (!id) return { ok: false, detail: "no clickable card" };
  const before = await page.locator(`[data-id="${id}"] .chip.kind`).count();
  await drag(await center(".lib-row"), await center(`[data-id="${id}"] .chips`));
  const after = await page.locator(`[data-id="${id}"] .chip.kind`).count();
  return { ok: after === before + 1, detail: `${before} → ${after} kind chips on ${id}` };
});
await step("editing two disk-model fields keeps both edits", async () => {
  await page.locator(".lib-row").first().click();
  const cap = page.locator(".props .field", { hasText: "Capacity (TB)" }).locator("input");
  await cap.fill("16");
  await cap.press("Enter");
  const lam = page.locator(".props .field", { hasText: "λ base (/h)" }).locator("input");
  await lam.fill("0.001");
  await lam.press("Enter");
  const k = (await state()).kinds.hdd8;
  return { ok: k.capacityTB === 16 && k.lambdaBase === 0.001, detail: `${k.capacityTB} TB / ${k.lambdaBase}` };
});
await step("double-clicking an unselected card edits in place without side effects", async () => {
  const before = await state();
  const target = await anyChild();
  const rect = await box(`[data-id="${target}"] .kv[data-editable]`);
  await page.mouse.click(rect.x + 40, rect.y + 6);
  await page.keyboard.press("Escape");
  await page.mouse.dblclick(rect.x + 40, rect.y + 6);
  const inputs = await page.locator(".node .kv input.inline").count();
  const after = await state();
  if (inputs) await page.locator(".node .kv input.inline").first().press("Escape");
  return {
    ok: inputs === 1 && JSON.stringify(after.kinds) === JSON.stringify(before.kinds),
    detail: `${inputs} inline editor(s)`,
  };
});
await step("the properties panel refreshes after a structural edit", async () => {
  await page.locator(".node.root .hd").click();
  const rowsBefore = await page.locator(".props .member-row").count();
  await page.locator(".props button", { hasText: "+ add pool member" }).click();
  const rowsAfter = await page.locator(".props .member-row").count();
  return { ok: rowsAfter === rowsBefore + 1, detail: `${rowsBefore} → ${rowsAfter} rows` };
});

// ---- links (pristine config: no free positions, no wrappers) ------------------------------------
await resetExample();

await step("dragging a port shows a rubber-band wire from that port", async () => {
  const id = (await deepCard()) || (await anyChild());
  if (!id) return { ok: false, detail: "no non-root card" };
  const p = await center(`[data-id="${id}"] .port.out`);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x - 50, p.y + 60);
  const d = await page.locator(".link-ghost").first().getAttribute("d");
  return {
    ok: (await page.locator(".link-ghost").count()) === 1 && /\d/.test(d || ""),
    detail: (d || "").slice(0, 44),
  };
});
await page.screenshot({ path: resolve(evidence, "ux-04-link-drag.png") });
await step("releasing a link in empty space cancels instead of deleting", async () => {
  const id = (await deepCard()) || (await anyChild());
  if (!id) return { ok: false, detail: "no non-root card" };
  const p = await center(`[data-id="${id}"] .port.out`);
  const point = await emptyPoint();
  if (!point) return { ok: false, detail: "no empty canvas area" };
  await page.evaluate(() => document.querySelectorAll(".toast").forEach((n) => n.remove()));
  const before = await poolPaths();
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(point.x, point.y);
  await page.mouse.move(point.x + 2, point.y + 2);
  await page.mouse.up();
  const after = await poolPaths();
  const toastText = await page.evaluate(() =>
    [...document.querySelectorAll(".toast")].map((n) => n.textContent).join(" | "),
  );
  return {
    ok: after.length === before.length && /kept/i.test(toastText),
    detail: `${before.length} → ${after.length} pools · ${toastText.slice(0, 50)}`,
  };
});
await step("dropping a link on another pool re-parents it", async () => {
  await tidyAndFit();
  const child = await anyChild();
  const other = await page.evaluate(
    (first) =>
      [...document.querySelectorAll(".node")]
        .map((n) => n.dataset.id)
        .find((id) => id !== first && !id.startsWith(first + ".")) || null,
    child,
  );
  if (!other) return { ok: false, detail: "need two unrelated pools" };
  const p = await center(`[data-id="${child}"] .port.out`);
  const target0 = await center(`[data-id="${other}"] .port.in`);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(target0.x, target0.y);
  await page.mouse.move(target0.x, target0.y + 2);
  await page.mouse.up();
  const nested = await page.evaluate(
    (id) => {
      const st = document.getElementById("app").__app.getState();
      let node = st.tree;
      for (const part of id.split(".").slice(1)) {
        const m = /^members\[(\d+)\]$/.exec(part);
        node = m ? node.members[Number(m[1])] : node[part];
      }
      return node.members.some((m) => m.node === "pool");
    },
    other,
  );
  return { ok: nested, detail: `${child} → ${other}` };
});
await step("an illegal drop explains itself and reverts", async () => {
  const start = await styleOf(".node.root");
  const from = await center(".node.root .hd");
  const deep = (await deepCard()) || (await anyChild());
  if (!deep) return { ok: false, detail: "no non-root card" };
  const onto = await center(`[data-id="${deep}"]`);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(onto.x, onto.y);
  const bad = await page.locator(`[data-id="${deep}"]`).first().evaluate((n) => n.classList.contains("drop-bad"));
  const reason = await page.locator(".drag-chip").textContent();
  await page.mouse.up();
  const end = await styleOf(".node.root");
  return {
    ok: bad && /top level|descendant|already/.test(reason) && end === start,
    detail: `${reason.trim().slice(0, 60)} · ${start} → ${end}`,
  };
});
await step("clicking a wire selects it and Delete cuts the link", async () => {
  const pt = await wirePoint();
  if (!pt.ok) return { ok: false, detail: `no reachable point on the wire (${pt.under})` };
  const before = (await poolPaths()).length;
  await page.mouse.click(pt.x, pt.y);
  const selected = await page.locator(".wire.sel").count();
  await page.keyboard.press("Delete");
  const after = (await poolPaths()).length;
  return { ok: selected === 1 && after === before - 1, detail: `${before} → ${after} cards` };
});
await step("clicking empty canvas clears a selected wire", async () => {
  const pt = await wirePoint();
  if (!pt.ok) return { ok: false, detail: `no reachable point on the wire (${pt.under})` };
  await page.mouse.click(pt.x, pt.y);
  const selected = await page.locator(".wire.sel").count();
  const point = await emptyPoint();
  if (!point) return { ok: false, detail: "no empty canvas area" };
  await page.mouse.click(point.x, point.y);
  const after = await page.locator(".wire.sel").count();
  return { ok: selected === 1 && after === 0, detail: `${selected} → ${after}` };
});
await step("hovering a wire offers a cut button that cuts", async () => {
  const pt = await wirePoint();
  if (!pt.ok) return { ok: false, detail: `no reachable point on the wire (${pt.under})` };
  await page.mouse.move(pt.x, pt.y);
  if ((await page.locator(".cut-btn").count()) === 0)
    return { ok: false, detail: "no cut button on hover" };
  const btn = await box(".cut-btn");
  const before = (await poolPaths()).length;
  await page.mouse.move(btn.x + btn.width / 2, btn.y + btn.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  const after = (await poolPaths()).length;
  return { ok: after < before, detail: `${before} → ${after} cards` };
});

await step("middle-drag pans without moving a card", async () => {
  const id = (await visibleCard()) || "tree";
  const before = await styleOf(`[data-id="${id}"]`);
  const posBefore = JSON.stringify((await state()).ui.pos);
  const c = await center(`[data-id="${id}"] .hd`);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(c.x + 60, c.y + 40);
  await page.mouse.up({ button: "middle" });
  return {
    ok: before === (await styleOf(`[data-id="${id}"]`)) && JSON.stringify((await state()).ui.pos) === posBefore,
    detail: `${before} unchanged`,
  };
});
await step("a rejected drop leaves no tooltip behind", async () => {
  const id = (await visibleCard()) || "tree";
  const t = await page.locator(`[data-id="${id}"]`).first().getAttribute("title");
  return { ok: !t || !/top level|descendant|already/.test(t), detail: `title: ${t || "(none)"}` };
});

// =================================================================================================
// 3. chrome: palette, shortcuts, scenario, context menu, language, theme
// =================================================================================================
await resetExample();

await step("Ctrl+K opens the command palette and runs a command", async () => {
  await page.keyboard.press("Control+k");
  await page.waitForSelector(".palette-modal", { timeout: 3000 });
  const rows = await page.locator(".palette-row").count();
  await page.locator(".palette-input").fill("drawer");
  await page.locator(".palette-input").press("Enter");
  const open = await page.locator(".drawer").isVisible();
  if (open) await page.keyboard.press("g");
  return { ok: rows > 5 && open };
});
await step("? opens the shortcut sheet", async () => {
  await page.keyboard.press("?");
  const n = await page.locator(".modal .keylist").count();
  await page.keyboard.press("Escape");
  return { ok: n === 1 };
});
await step("the scenario chip selects the scenario form", async () => {
  await page.locator("button.chip-btn").click();
  return { ok: (await page.locator(".props h3").textContent()) === "Scenario" };
});
await step("the context menu can wrap a pool in a new pool", async () => {
  if (await page.locator(".drawer").isVisible()) await page.keyboard.press("g");
  const child = await anyChild();
  if (!child) return { ok: false, detail: "no non-root card" };
  const before = (await poolPaths()).length;
  const hd = await box(`[data-id="${child}"] .hd`);
  await page.mouse.click(hd.x + hd.width / 2, hd.y + hd.height / 2, { button: "right" });
  await page.waitForSelector(".menu", { timeout: 3000 });
  const item = page.locator(".menu-item", { hasText: "Wrap in a new pool" });
  if ((await item.count()) === 0)
    return { ok: false, detail: `items: ${JSON.stringify(await page.locator(".menu-item").allTextContents())}` };
  await item.click({ timeout: 3000 });
  return { ok: (await poolPaths()).length === before + 1, detail: `${before} → ${await poolPaths().then((p) => p.length)} cards` };
});

await step("the language selector switches the UI to Chinese and back", async () => {
  await page.selectOption(".mini-select >> nth=0", { label: "中文" });
  const zhRun = await page.locator("header button", { hasText: "运行" }).count();
  const zhTidy = await page.locator('button[data-act="tidy"]').textContent();
  const zhHint = await page.locator(".hud-hint").textContent();
  const zhProps = await page.locator(".props h3").textContent();
  await page.selectOption(".mini-select >> nth=0", { label: "EN" });
  const enRun = await page.locator("header button", { hasText: "Run" }).count();
  return {
    ok: zhRun === 1 && zhTidy === "整理" && zhHint.includes("缩放") && enRun === 1,
    detail: `zh: ${zhTidy} / ${zhHint.slice(0, 16)} / props="${zhProps}"`,
  };
});
await step("the language choice survives a reload and lands in the config", async () => {
  await page.selectOption(".mini-select >> nth=0", { label: "中文" });
  const stored = await page.evaluate(() => localStorage.getItem("raid_calc:prefs"));
  const inConfig = await page.evaluate(() => document.getElementById("app").__app.getState().ui.lang);
  await page.reload();
  await page.waitForSelector(".node.root", { timeout: 15000 });
  const afterReload = await page.locator("header button", { hasText: "运行" }).count();
  await page.selectOption(".mini-select >> nth=0", { label: "EN" });
  return {
    ok: afterReload === 1 && inConfig === "zh" && /zh/.test(stored || ""),
    detail: `prefs=${stored}, config.ui.lang=${inConfig}, after reload=${afterReload}`,
  };
});
await step("the theme selector switches to light and back", async () => {
  await page.selectOption(".mini-select >> nth=1", { label: "☀" });
  const light = await page.evaluate(() => document.documentElement.dataset.theme);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const contrast = await page.evaluate(() => {
    const el = document.querySelector(".node");
    return { node: getComputedStyle(el).backgroundColor, canvas: getComputedStyle(document.querySelector(".canvas")).backgroundColor };
  });
  await page.selectOption(".mini-select >> nth=1", { label: "🌙" });
  const dark = await page.evaluate(() => document.documentElement.dataset.theme);
  return {
    ok: light === "light" && dark === "dark" && bg !== "rgb(20, 22, 26)",
    detail: `${light} (body ${bg}, node ${contrast.node}) → ${dark}`,
  };
});

await step("wheel zooms the canvas", async () => {
  const z0 = await page.locator(".zoom-label").textContent();
  await page.locator(".canvas").hover();
  await page.mouse.wheel(0, -360);
  const z1 = await page.locator(".zoom-label").textContent();
  return { ok: z0 !== z1, detail: `${z0} → ${z1}` };
});
await step("F fits the view to the content", async () => {
  const z1 = await page.locator(".zoom-label").textContent();
  await page.keyboard.press("f");
  const z2 = await page.locator(".zoom-label").textContent();
  return { ok: z2 !== z1, detail: `${z1} → ${z2}` };
});
await step("the minimap shows a viewport rectangle", async () => ({
  ok: (await page.locator(".minimap .mm-view").count()) === 1,
}));

await step("deleting an ancestor of the selection is handled", async () => {
  const errors0 = errors.length;
  const deep = (await deepCard()) || (await anyChild());
  if (!deep) return { ok: false, detail: "no non-root card" };
  await page.locator(`[data-id="${deep}"] .hd`).click();
  await page.mouse.move(5, 500);
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const rootNode = document.querySelector('[data-id="tree"]');
    const rm = rootNode.querySelector(".chip.pool .rm");
    if (rm) rm.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  });
  await page.waitForTimeout(700);
  return { ok: errors.length === errors0, detail: errors.slice(errors0).join(" | ") || "no errors" };
});

await page.screenshot({ path: resolve(evidence, "ux-05-final.png") });

await step("no console or page errors", async () => ({
  ok: errors.length === 0,
  detail: errors.slice(0, 3).join(" | "),
}));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);
