// Browser smoke test for the canvas UX (ticket 14). Drives the real bundle with real pointer
// gestures and asserts the observable DOM and the live config, then writes screenshots as evidence.
//
//   node scripts/ux-smoke.mjs [path/to/raid-calc.html]
//
// Exit code 1 if any check fails or the page logs an error. Every check is recorded even when an
// interaction throws, so a broken step reports a FAIL instead of silently skipping the assertion.

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

// Prefer the bundled playwright browser; fall back to any already-downloaded chromium build.
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
page.on("pageerror", (e) => errors.push(String(e.stack || e).split("\n").slice(0, 3).join(" | ")));

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
  page.evaluate(() =>
    [...document.querySelectorAll(".node")].map((n) => n.dataset.id),
  );
// the path of the first pool that has a parent of its own (depth >= 2)
const nestedPath = () =>
  page.evaluate(() => {
    const ids = [...document.querySelectorAll(".node")].map((n) => n.dataset.id);
    return ids.find((id) => (id.match(/\.members\[/g) || []).length >= 2) || null;
  });
// A point that really is on the first wire and really is the topmost element there: sampled along
// the path and confirmed with elementFromPoint. Returns null when no point on the wire is reachable,
// which is itself a defect (wires must be clickable).
const wirePoint = () =>
  page.evaluate(() => {
    const hit = document.querySelector(".wire-hit");
    if (!hit) return { ok: false, under: "no .wire-hit in the DOM" };
    const m = hit.getScreenCTM();
    const len = hit.getTotalLength();
    const seen = new Set();
    const samples = [];
    let last = null;
    for (let t = 0; t <= 1.0001; t += 0.02) {
      const p = hit.getPointAtLength(len * t);
      const x = m.a * p.x + m.c * p.y + m.e;
      const y = m.b * p.x + m.d * p.y + m.f;
      const e = document.elementFromPoint(x, y);
      const under = e ? `${e.tagName}.${e.getAttribute("class") || ""}` : "none";
      seen.add(under);
      if (samples.length < 3) samples.push(`${t.toFixed(2)}@${x | 0},${y | 0}:${under}`);
      last = { x, y };
      if (e && e.classList && e.classList.contains("wire-hit"))
        return { x, y, ok: true, under };
    }
    return {
      ok: false,
      under: `wire len ${len | 0}, box ${hit.getBoundingClientRect().width | 0}x${hit.getBoundingClientRect().height | 0}, saw [${[...seen].join(", ")}], first ${samples.join(" ")}`,
      ...(last || {}),
    };
  });

const cardRects = () =>
  page.evaluate(() =>
    [...document.querySelectorAll(".node")]
      .map((n) => {
        const r = n.getBoundingClientRect();
        return `${n.dataset.id} ${r.x | 0},${r.y | 0} ${r.height | 0}h sel=${n.classList.contains("sel")} prev=${!!n.querySelector(".nodepreview")} inline=${n.style.top}`;
      })
      .join(" | "),
  );

// Record the check even if the interaction throws.
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

// --- structure ----------------------------------------------------------------------------------

await step("root card exists and is labelled top-level", async () => ({
  ok: (await page.locator(".node.root .badge").first().textContent()) === "TOP-LEVEL",
  detail: await page.locator(".node.root .badge").first().textContent(),
}));
await step("the config has no output node and the root is the top-level pool", async () => {
  const s = await state();
  return {
    ok: s.tree.node === "pool" && !("output" in s),
    detail: `config keys: ${Object.keys(s).join(",")}`,
  };
});
await step("root carries the result ribbon", async () => ({
  ok: (await page.locator(".node.root .ribbon").count()) === 1,
}));
await step("canvas holds exactly the pool cards, one per pool node", async () => {
  const paths = await poolPaths();
  const s = await state();
  let pools = 0;
  const walk = (n) => {
    pools++;
    (n.members || []).forEach((m) => m.node === "pool" && walk(m));
  };
  walk(s.tree);
  return { ok: paths.length === pools && pools === 3, detail: `${paths.length} cards / ${pools} pools` };
});
await step("disk kinds are library rows, never canvas cards", async () => ({
  ok: (await page.locator(".lib-row").count()) === 1 && (await page.locator(".node .badge", { hasText: "DISK" }).count()) === 0,
}));
await step("a wire is drawn for every pool child", async () => ({
  ok: (await page.locator(".wire").count()) === (await poolPaths()).length - 1,
  detail: `${await page.locator(".wire").count()} wires`,
}));
await step("minimap sits in the bottom-right corner of the canvas", async () => {
  const mm = await box(".minimap");
  const cv = await box(".canvas");
  return {
    ok: mm.x + mm.width > cv.x + cv.width - 40 && mm.y + mm.height > cv.y + cv.height - 40,
    detail: `minimap@${mm.x | 0},${mm.y | 0} canvas right/bottom ${(cv.x + cv.width) | 0}/${(cv.y + cv.height) | 0}`,
  };
});
await page.screenshot({ path: resolve(evidence, "ux-01-initial.png") });

// --- run + drawer -------------------------------------------------------------------------------

await step("Run fills the root ribbon", async () => {
  await page.keyboard.press("r");
  await page.waitForSelector(".node.root .rb-v", { timeout: 180000 });
  const v = await page.locator(".node.root .rb-v").first().textContent();
  return { ok: !!v && v !== "", detail: `E[lost] = ${v}` };
});
await step("the ribbon opens the results drawer with both charts", async () => {
  await page.locator(".node.root .ribbon").click();
  await page.waitForSelector(".drawer .drawer-chart svg", { timeout: 5000 });
  return {
    ok: (await page.locator(".drawer .drawer-chart svg").count()) === 2,
    detail: `${await page.locator(".drawer .drawer-chart svg").count()} charts`,
  };
});
await page.screenshot({ path: resolve(evidence, "ux-02-run-drawer.png") });
await step("a curve can be pinned as an overlay", async () => {
  await page.locator(".drawer-head button", { hasText: "Pin current" }).click();
  return { ok: (await page.locator(".drawer-head button", { hasText: "Clear pins" }).count()) === 1 };
});
await page.keyboard.press("g");

await step("the selected card shows a standalone preview popover that does not disturb layout", async () => {
  await page.locator('[data-id="tree.members[0]"] .hd').click();
  const cardBefore = await styleOf('[data-id="tree.members[0]"]');
  let text = null;
  for (let i = 0; i < 40 && text === null; i++) {
    const st = await page.evaluate(() => {
      const p = document.querySelector(".preview-pop");
      if (!p || p.hidden || !document.querySelector(".preview-pop .np-row")) return null;
      return p.textContent;
    });
    if (st === null) await page.waitForTimeout(250);
    else text = st;
  }
  if (text === null)
    return {
      ok: false,
      detail: `popover: ${await page.evaluate(() => {
        const p = document.querySelector(".preview-pop");
        return p ? `${p.hidden ? "hidden " : ""}${p.innerHTML.slice(0, 120) || "(empty)"}` : "missing";
      })} · selection=${await page.evaluate(() => document.querySelector(".node.sel")?.dataset.id)}`,
    };
  const cardAfter = await styleOf('[data-id="tree.members[0]"]');
  return {
    ok: /E\[lost\]/.test(text) && cardBefore === cardAfter,
    detail: `${text.replace(/\s+/g, " ").trim().slice(0, 60)} · card ${cardBefore} → ${cardAfter}`,
  };
});

// --- free drag / tidy ---------------------------------------------------------------------------

await step("cards are draggable and keep a free position", async () => {
  const before = await styleOf(".node.root");
  const c = await center(".node.root .hd");
  await drag(c, { x: c.x + 200, y: c.y - 70 });
  const after = await styleOf(".node.root");
  return { ok: before !== after, detail: `${before} → ${after}` };
});
await step("Tidy forgets manual positions and re-runs the auto layout", async () => {
  const before = await styleOf(".node.root");
  const stored = (await state()).ui.pos;
  await page.locator('button[data-act="tidy"]').click();
  const after = await styleOf(".node.root");
  return {
    ok: before !== after && Object.keys((await state()).ui.pos).length === 0,
    detail: `${before} → ${after}, pos was ${JSON.stringify(stored)}`,
  };
});
await step("Escape cancels a drag and nothing is committed", async () => {
  const c = await center(".node.root .hd");
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 160, c.y + 120);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  const pos = (await state()).ui.pos;
  return {
    ok: Object.keys(pos).length === 0 && (await styleOf(".node.root")) === "450px,320px",
    detail: `pos=${JSON.stringify(pos)}`,
  };
});

// --- re-parent ----------------------------------------------------------------------------------

await step("dropping a card on a pool re-parents it (and highlights the target)", async () => {
  const target0 = await center('[data-id="tree.members[0]"]');
  const src1 = await center('[data-id="tree.members[1]"] .hd');
  await page.mouse.move(src1.x, src1.y);
  await page.mouse.down();
  await page.mouse.move(src1.x - 40, src1.y - 30);
  await page.mouse.move(target0.x, target0.y);
  const highlighted = await page.locator('[data-id="tree.members[0]"]').first().evaluate((n) => n.classList.contains("drop-ok"));
  await page.mouse.up();
  const s = await state();
  return {
    ok: highlighted && s.tree.members.length === 1 && s.tree.members[0].members.length === 2,
    detail: `root members ${s.tree.members.length}, nested ${s.tree.members[0].members.length}`,
  };
});
await page.screenshot({ path: resolve(evidence, "ux-03-reparented.png") });
await step("a re-parented pool keeps a card of its own", async () => ({
  ok: (await page.locator('[data-id="tree.members[0].members[1]"]').count()) === 1,
}));

// --- nested-card operations (these were the paths with the sharpest edges) ----------------------

await step("clicking a nested card shows its form", async () => {
  await page.locator('[data-id="tree.members[0]"] .hd').click();
  await page.waitForSelector(".props h3", { timeout: 3000 });
  return {
    ok: (await page.locator(".props h3").textContent()).startsWith("Pool"),
    detail: await page.locator(".props h3").textContent(),
  };
});
await step("editing a nested pool's D writes to the pool, not the scenario", async () => {
  const field = page.locator(".props .field", { hasText: "D data members" }).locator("input");
  await field.fill("5");
  await field.press("Enter");
  const s = await state();
  return {
    ok: s.tree.members[0].d === 5 && s.workload.d === undefined,
    detail: `pool.d=${s.tree.members[0].d}, workload.d=${s.workload.d}`,
  };
});
await step("changing a nested pool's strategy applies to that pool", async () => {
  const sel = page.locator(".props .field", { hasText: "Strategy" }).locator("select");
  await sel.selectOption("concat");
  const s = await state();
  return {
    ok: s.tree.members[0].strategy === "concat",
    detail: `nested strategy=${s.tree.members[0].strategy}`,
  };
});
await step("the ✕ on a member chip removes that member", async () => {
  const before = (await state()).tree.members[0].members.length;
  await page.locator('[data-id="tree.members[0]"] .chip.kind .rm').first().click({ force: true });
  const after = (await state()).tree.members[0].members.length;
  return { ok: after === before - 1, detail: `${before} → ${after} members` };
});
await step("a library drag adds a disk member to the pool under the cursor", async () => {
  const before = (await state()).tree.members[0].members.length;
  await drag(await center(".lib-row"), await center('[data-id="tree.members[0]"] .chips'));
  const after = (await state()).tree.members[0].members.length;
  return { ok: after === before + 1, detail: `${before} → ${after} members` };
});
await step("a properties edit is reflected on the cards", async () => {
  await page.locator('[data-id="tree"] .hd').click();
  await page.locator(".props .field", { hasText: "λ common-cause" }).locator("input").fill("0.003");
  await page.locator(".props .field", { hasText: "λ common-cause" }).locator("input").press("Enter");
  const shown = await page.locator('[data-id="tree"] .kv', { hasText: "λcc" }).first().textContent();
  return { ok: shown.includes("3.0e-3"), detail: shown.trim() };
});
await step("double-clicking an unselected card edits it in place without side effects", async () => {
  const before = await state();
  const target = '[data-id="tree.members[0]"] .kv[data-editable]';
  const target0 = await box(target);
  await page.mouse.click(target0.x + 40, target0.y + 6);
  await page.keyboard.press("Escape");
  await page.mouse.dblclick(target0.x + 40, target0.y + 6);
  const input = await page.locator(".node .kv input.inline").count();
  const after = await state();
  if (input) await page.locator(".node .kv input.inline").first().press("Escape");
  return {
    ok: input === 1 && JSON.stringify(after.kinds) === JSON.stringify(before.kinds),
    detail: `${input} inline editor(s); kinds unchanged: ${JSON.stringify(after.kinds) === JSON.stringify(before.kinds)}`,
  };
});
await step("a collapsed pool hides its whole subtree", async () => {
  const before = (await poolPaths()).length;
  await page.locator('[data-id="tree.members[0]"] .chev').click();
  const after = (await poolPaths()).length;
  await page.locator('[data-id="tree.members[0]"] .chev').click();
  return { ok: after === before - 1, detail: `${before} → ${after} cards` };
});

// --- link create / cut --------------------------------------------------------------------------

const nested = await nestedPath();
await step("dragging a port shows a rubber-band wire from that port", async () => {
  const p = await center(`[data-id="${nested}"] .port.out`);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x - 50, p.y + 60);
  const d = await page.locator(".link-ghost").first().getAttribute("d");
  return { ok: (await page.locator(".link-ghost").count()) === 1 && /\d/.test(d || ""), detail: (d || "").slice(0, 44) };
});
await screenshotLink(page, evidence);
await step("dropping the link on another pool re-parents it", async () => {
  const ri = await center('[data-id="tree"] .port.in');
  await page.mouse.move(ri.x, ri.y);
  await page.mouse.move(ri.x, ri.y + 2);
  await page.mouse.up();
  const s = await state();
  return {
    ok: s.tree.members.length === 2 && s.tree.members[0].members.length === 1,
    detail: `root members ${s.tree.members.length}`,
  };
});
await step("an illegal drop explains itself and reverts", async () => {
  const start = await styleOf(".node.root");
  const from = await center(".node.root .hd");
  const onto = await center('[data-id="tree.members[0]"]');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(onto.x, onto.y);
  const bad = await page.locator('[data-id="tree.members[0]"]').first().evaluate((n) => n.classList.contains("drop-bad"));
  const reason = await page.locator(".drag-chip").textContent();
  await page.mouse.up();
  const end = await styleOf(".node.root");
  return {
    ok: bad && /top level|descendant|already/.test(reason) && end === start,
    detail: `${reason.trim()} · ${start} → ${end}`,
  };
});
await step("clicking a wire selects it and Delete cuts the link", async () => {
  const pt = await wirePoint();
  const before = (await poolPaths()).length;
  if (!pt.ok)
    return {
      ok: false,
      detail: `no reachable point on the wire (${pt.under}) · rects=${await cardRects()}`,
    };
  await page.mouse.click(pt.x, pt.y);
  const selected = await page.locator(".wire.sel").count();
  await page.keyboard.press("Delete");
  const after = (await poolPaths()).length;
  return {
    ok: selected === 1 && after === before - 1,
    detail: `selected ${selected}; ${before} → ${after} cards`,
  };
});
await step("hovering a wire offers a cut button", async () => {
  const pt = await wirePoint();
  if (!pt.ok)
    return {
      ok: false,
      detail: `no reachable point on the wire (${pt.under}) · rects=${await cardRects()}`,
    };
  await page.mouse.move(pt.x, pt.y);
  return { ok: (await page.locator(".cut-btn").count()) >= 1, detail: pt.under };
});
await page.mouse.move(10, 500);

// --- viewport + chrome --------------------------------------------------------------------------

await step("middle-drag pans without moving a card", async () => {
  const before = await styleOf('[data-id="tree.members[0]"]');
  const posBefore = JSON.stringify((await state()).ui.pos);
  const c = await center('[data-id="tree.members[0]"] .hd');
  await page.mouse.move(c.x, c.y);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(c.x + 60, c.y + 40);
  await page.mouse.up({ button: "middle" });
  const after = await styleOf('[data-id="tree.members[0]"]');
  return {
    ok: before === after && JSON.stringify((await state()).ui.pos) === posBefore,
    detail: `${before} → ${after}`,
  };
});

await step("a config edit keeps the last run, flagged stale", async () => {
  await page.locator('[data-id="tree"] .hd').click();
  const f = page.locator(".props .field", { hasText: "λ common-cause" }).locator("input");
  await f.fill("0.001");
  await f.press("Enter");
  await page.keyboard.press("t"); // force a full canvas re-render
  const cells = await page.locator(".node.root .rb-v").count();
  const stale = await page.locator(".node.root .rb-stale").count();
  return { ok: cells === 4 && stale === 1, detail: `${cells} metrics, ${stale} stale marker` };
});

await step("one Enter is one undo step", async () => {
  await page.locator('[data-id="tree"] .hd').click();
  const f = page.locator(".props .field", { hasText: "λ common-cause" }).locator("input");
  const before = (await state()).tree.lambdaCC;
  const cand = before === 0.002 ? 0.003 : 0.002;
  await f.fill(String(cand));
  await f.press("Enter");
  await page.keyboard.press("Control+z");
  const after = (await state()).tree.lambdaCC;
  return { ok: after === before, detail: `${before} → ${cand} → undo → ${after}` };
});

await step("clicking empty canvas clears a selected wire", async () => {
  const pt = await wirePoint();
  if (!pt.ok) return { ok: false, detail: `no reachable point on the wire (${pt.under})` };
  await page.mouse.click(pt.x, pt.y);
  const selected = await page.locator(".wire.sel").count();
  const cv = await box(".canvas");
  await page.mouse.click(cv.x + cv.width - 40, cv.y + 60);
  const after = await page.locator(".wire.sel").count();
  return { ok: selected === 1 && after === 0, detail: `wire sel ${selected} → ${after}` };
});

await step("deleting an ancestor of the selection is handled", async () => {
  const errors0 = errors.length;
  // build a depth-2 card first: wrap the first member in a new pool
  const firstChild = await page.evaluate(
    () => [...document.querySelectorAll(".node")].find((n) => !n.classList.contains("root"))?.dataset.id,
  );
  await page.locator(`[data-id="${firstChild}"] .hd`).click();
  await page.keyboard.press("Control+k");
  await page.waitForSelector(".palette-modal", { timeout: 3000 });
  await page.locator(".palette-input").fill("wrap");
  await page.locator(".palette-input").press("Enter");
  const deep = await page.evaluate(
    () =>
      [...document.querySelectorAll(".node")]
        .map((n) => n.dataset.id)
        .filter((id) => (id.match(/\.members\[/g) || []).length >= 2)[0],
  );
  if (!deep)
    return { ok: false, detail: "no depth-2 card to select" };
  await page.locator(`[data-id="${deep}"] .hd`).click();
  await page.mouse.move(5, 500);
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const root = document.querySelector('[data-id="tree"]');
    const rm = root.querySelector(".chip.pool .rm");
    if (rm) rm.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  });
  await page.waitForTimeout(700);
  return { ok: errors.length === errors0, detail: errors.slice(errors0).join(" | ") || "no errors" };
});

await step("the properties panel refreshes after a structural edit", async () => {
  await page.locator('[data-id="tree"] .hd').click();
  const rowsBefore = await page.locator(".props .member-row").count();
  await page.locator(".props button", { hasText: "+ add pool member" }).click();
  const rowsAfter = await page.locator(".props .member-row").count();
  const cfgMembers = (await state()).tree.members.length;
  return {
    ok: rowsAfter === rowsBefore + 1 && cfgMembers === rowsAfter,
    detail: `rows ${rowsBefore} → ${rowsAfter}, config has ${cfgMembers}`,
  };
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
  return {
    ok: k.capacityTB === 16 && k.lambdaBase === 0.001,
    detail: `capacity=${k.capacityTB}, lambdaBase=${k.lambdaBase}`,
  };
});

await step("wrapping a non-pool selection is refused, not thrown", async () => {
  const errors0 = errors.length;
  await page.locator(".lib-row").first().click();
  await page.keyboard.press("Control+k");
  await page.waitForSelector(".palette-modal", { timeout: 3000 });
  await page.locator(".palette-input").fill("wrap");
  await page.locator(".palette-input").press("Enter");
  return {
    ok: errors.length === errors0 && (await page.locator(".toast").count()) >= 1,
    detail: `${(await page.locator(".toast").first().textContent()) || "no toast"}`,
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
await step("Ctrl+K opens the command palette and runs a command", async () => {
  await page.keyboard.press("Control+k");
  await page.waitForSelector(".palette-modal", { timeout: 3000 });
  const rows = await page.locator(".palette-row").count();
  await page.locator(".palette-input").fill("drawer");
  await page.locator(".palette-input").press("Enter");
  return { ok: rows > 5 && (await page.locator(".drawer").isVisible()) };
});
await page.keyboard.press("Escape");
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
  // the palette step left the results drawer open over the bottom of the canvas
  if (await page.locator(".drawer").isVisible()) await page.keyboard.press("g");
  const before = await state();
  const beforeCount = (await poolPaths()).length;
  const anyChild = await page.evaluate(
    () => [...document.querySelectorAll(".node")].find((n) => !n.classList.contains("root"))?.dataset.id,
  );
  if (!anyChild) return { ok: false, detail: "no non-root card on the canvas" };
  const hdBox = await box(`[data-id="${anyChild}"] .hd`);
  const underHd = await page.evaluate(([x, y]) => {
    const e = document.elementFromPoint(x, y);
    return e ? `${e.tagName}.${e.getAttribute("class")}` : "none";
  }, [hdBox.x + hdBox.width / 2, hdBox.y + hdBox.height / 2]);
  if (!underHd.includes("hd") && !underHd.includes("node"))
    return { ok: false, detail: `card header covered by ${underHd} (drawer ${await page.locator(".drawer").isVisible()})` };
  await page.mouse.click(hdBox.x + hdBox.width / 2, hdBox.y + hdBox.height / 2, { button: "right" });
  await page.waitForSelector(".menu", { timeout: 3000 });
  const childPath = anyChild;
  const item = page.locator(".menu-item", { hasText: "Wrap in a new pool" });
  if ((await item.count()) === 0)
    return {
      ok: false,
      detail: `menu items: ${JSON.stringify(await page.locator(".menu-item").allTextContents())}`,
    };
  const d = await page.evaluate(() => {
    const menu = document.querySelector(".menu");
    const r = menu.getBoundingClientRect();
    const it = [...menu.querySelectorAll(".menu-item")].find((b) =>
      b.textContent.includes("Wrap in a new pool"),
    );
    const ir = it.getBoundingClientRect();
    const e = document.elementFromPoint(ir.x + ir.width / 2, ir.y + ir.height / 2);
    return {
      menu: `${r.x | 0},${r.y | 0} ${r.width | 0}x${r.height | 0}`,
      item: `${ir.x | 0},${ir.y | 0} ${ir.width | 0}x${ir.height | 0}`,
      under: e ? `${e.tagName}.${e.getAttribute("class")}` : "none",
      menus: document.querySelectorAll(".menu").length,
    };
  });
  try {
    await item.click({ timeout: 3000 });
  } catch (e) {
    return { ok: false, detail: `${JSON.stringify(d)} · ${String(e.message).split("\n")[0]}` };
  }
  const after = await state();
  const pools = [];
  const walk = (n, path) => {
    pools.push({ path, n });
    (n.members || []).forEach((m, i) => m.node === "pool" && walk(m, `${path}.members[${i}]`));
  };
  walk(after.tree, "tree");
  const wrapper = pools.find(
    (p) => p.path === childPath && p.n.members.length === 1 && p.n.members[0].node === "pool",
  );
  return {
    ok: (await poolPaths()).length === beforeCount + 1 && !!wrapper,
    detail: wrapper
      ? `wrapper at ${wrapper.path} holds 1 pool (${wrapper.n.members[0].strategy})`
      : `no wrapper found around ${childPath}`,
  };
});
await screenshotLink(page, evidence, "ux-05-final.png");

await step("no console or page errors", async () => ({
  ok: errors.length === 0,
  detail: errors.slice(0, 3).join(" | "),
}));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);

async function screenshotLink(p, dir, name = "ux-04-link-drag.png") {
  await p.screenshot({ path: resolve(dir, name) });
}
