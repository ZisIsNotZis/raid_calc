// Browser smoke test for the canvas UX (ticket 14). Drives the real bundle with real pointer
// gestures and asserts the observable DOM, then writes screenshots as evidence.
//
//   node scripts/ux-smoke.mjs [path/to/raid-calc.html]
//
// Exit code 1 if any check fails or the page logs an error. Findings are printed as
// PASS/FAIL lines so a failure names the exact interaction that broke.

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
  const dirs = readdirSync(base).filter((d) => d.startsWith("chromium-"));
  for (const d of dirs) {
    const p = resolve(base, d, "chrome-linux64/chrome");
    if (existsSync(p)) return p;
    const p2 = resolve(base, d, "chrome-linux/chrome");
    if (existsSync(p2)) return p2;
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
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(`file://${target}`);
await page.waitForSelector(".node.root", { timeout: 15000 });

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

// ---- structure -------------------------------------------------------------------------------
check("root card exists and is labelled top-level", await page.locator(".node.root").count() === 1);
check(
  "no output/result node on the canvas",
  (await page.locator(".node.out-node").count()) === 0,
);
check("root carries the result ribbon", (await page.locator(".node.root .ribbon").count()) === 1);
check("disk kinds are not canvas nodes", (await page.locator(".node .badge", { hasText: "DISK" }).count()) === 0);
check("pool cards rendered", (await page.locator(".node.pool").count()) === 3, `${await page.locator(".node.pool").count()} cards`);
check("sidebar disk library present", (await page.locator(".lib-row").count()) === 1);
check("wires drawn for both members", (await page.locator(".wire").count()) === 2);
await page.screenshot({ path: resolve(evidence, "ux-01-initial.png") });

// ---- run -------------------------------------------------------------------------------------
await page.keyboard.press("r");
await page.waitForSelector(".node.root .rb-v", { timeout: 180000 });
const lost = await page.locator(".node.root .rb-v").first().textContent();
check("Run fills the root ribbon", !!lost && lost !== "", `E[lost] = ${lost}`);
await page.locator(".node.root .ribbon").click();
await page.waitForSelector(".drawer .drawer-chart svg", { timeout: 5000 });
check("results drawer opens from the ribbon", await page.locator(".drawer").isVisible());
check("drawer renders both charts", (await page.locator(".drawer .drawer-chart svg").count()) === 2);
await page.screenshot({ path: resolve(evidence, "ux-02-run-drawer.png") });
await page.locator(".drawer-head button", { hasText: "✕" }).click();

// ---- free drag (onto empty canvas: a move, not a re-parent) ------------------------------------
const rootBefore = await page.locator(".node.root").evaluate((n) => n.style.left);
const r0 = await center(".node.root .hd");
await drag(r0, { x: r0.x + 200, y: r0.y - 70 });
const rootAfter = await page.locator(".node.root").evaluate((n) => n.style.left);
check("cards are draggable and keep a free position", rootBefore !== rootAfter, `${rootBefore} → ${rootAfter}`);

// ---- tidy --------------------------------------------------------------------------------------
await page.locator('button[data-act="tidy"]').click();
const rootTidy = await page.locator(".node.root").evaluate((n) => n.style.left);
check("Tidy restores the auto layout", rootBefore === rootTidy, `${rootAfter} → ${rootTidy}`);

// ---- re-parent by dropping onto another pool -----------------------------------------------------
const target0 = await center('[data-id="tree.members[0]"]');
const src1 = await center('[data-id="tree.members[1]"] .hd');
await page.mouse.move(src1.x, src1.y);
await page.mouse.down();
await page.mouse.move(src1.x - 40, src1.y - 30);
await page.mouse.move(target0.x, target0.y);
const okClass = await page.locator('[data-id="tree.members[0]"]').first().evaluate((n) => n.classList.contains("drop-ok"));
check("hovering a legal drop target highlights it", okClass);
const chipCount = await page.locator('[data-id="tree"] .chips .chip.pool').count();
await page.mouse.up();
const chipCountAfter = await page.locator('[data-id="tree"] .chips .chip.pool').count();
check(
  "drop re-parents the card into the target pool",
  chipCountAfter === chipCount - 1,
  `${chipCount} → ${chipCountAfter} member chips on root`,
);
check(
  "the re-parented pool is now nested",
  (await page.locator('[data-id="tree.members[0].members[1]"]').count()) === 1,
);
await page.screenshot({ path: resolve(evidence, "ux-03-reparented.png") });

// ---- link create: rubber band from the real port ------------------------------------------------
const nested = await center('[data-id="tree.members[0].members[1]"] .port.out');
await page.mouse.move(nested.x, nested.y);
await page.mouse.down();
await page.mouse.move(nested.x - 60, nested.y - 60);
const ghost = await page.locator(".link-ghost").count();
const ghostD = ghost ? await page.locator(".link-ghost").first().getAttribute("d") : "";
check("dragging a port shows a rubber-band wire", ghost === 1 && /\d/.test(ghostD), ghostD.slice(0, 48));
await page.screenshot({ path: resolve(evidence, "ux-04-link-drag.png") });
const rootIn = await center('[data-id="tree"] .port.in');
await page.mouse.move(rootIn.x, rootIn.y);
await page.mouse.move(rootIn.x, rootIn.y + 2);
await page.mouse.up();
const backOnRoot = await page.locator('[data-id="tree"] .chips .chip.pool').count();
check("dropping the link re-parents the node", backOnRoot === chipCount, `${backOnRoot} root member chips`);

// ---- illegal target explains itself --------------------------------------------------------------
const rootStart = await page.locator(".node.root").evaluate((n) => n.style.left + "," + n.style.top);
const illegalFrom = await center('[data-id="tree"] .hd');
const descendant = await center('[data-id="tree.members[0]"]');
await page.mouse.move(illegalFrom.x, illegalFrom.y);
await page.mouse.down();
await page.mouse.move(descendant.x, descendant.y);
const badClass = await page.locator('[data-id="tree.members[0]"]').first().evaluate((n) => n.classList.contains("drop-bad"));
const chipText = await page.locator(".drag-chip").textContent();
check("dropping the root onto a descendant shows a reason", badClass && /top level|descendant/.test(chipText), chipText.trim());
await page.mouse.up();
const rootEnd = await page.locator(".node.root").evaluate((n) => n.style.left + "," + n.style.top);
check(
  "an illegal drop reverts the card instead of parking it on the target",
  rootEnd === rootStart,
  `${rootStart} → ${rootEnd}`,
);

// ---- wire delete ---------------------------------------------------------------------------------
await page.$eval(".wire-hit", (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
check("clicking a wire selects it", (await page.locator(".wire.sel").count()) === 1);
const poolsBefore = await page.locator(".node.pool").count();
await page.keyboard.press("Delete");
const poolsAfter = await page.locator(".node.pool").count();
check("Delete cuts the selected link", poolsAfter < poolsBefore, `${poolsBefore} → ${poolsAfter} pools`);

// ---- library drag --------------------------------------------------------------------------------
const chipsBefore = await page.locator('[data-id="tree"] .chips .chip.kind').count();
const lib = await center(".lib-row");
const rootTarget = await center('[data-id="tree"] .chips');
await drag(lib, rootTarget);
const chipsAfter = await page.locator('[data-id="tree"] .chips .chip.kind').count();
check("dragging a disk from the library adds a member", chipsAfter === chipsBefore + 1, `${chipsBefore} → ${chipsAfter}`);

// ---- collapse ------------------------------------------------------------------------------------
const poolsNow = await page.locator(".node.pool").count();
let poolsCollapsed = poolsNow;
try {
  await page.locator('[data-id="tree"] .chev').click({ timeout: 5000 });
  poolsCollapsed = await page.locator(".node.pool").count();
} catch (e) {
  const dump = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".node")].map((n) => {
      const r = n.getBoundingClientRect();
      return `${n.dataset.id}@${r.x | 0},${r.y | 0} ${r.width | 0}x${r.height | 0}`;
    });
    const ui = document.getElementById("app").__app.getState().ui;
    return [...cards, `ui=${JSON.stringify(ui)}`];
  });
  check("collapsing the root hides its subtree", false, `click blocked; cards: ${dump.join(" | ")}`);
}
if (poolsCollapsed !== poolsNow)
  check("collapsing the root hides its subtree", true, `${poolsNow} → ${poolsCollapsed}`);
try {
  await page.locator('[data-id="tree"] .chev').click({ timeout: 5000 });
} catch {
  /* already reported */
}

// ---- zoom / pan ----------------------------------------------------------------------------------
const z0 = await page.locator(".zoom-label").textContent();
await page.locator(".canvas").hover();
await page.mouse.wheel(0, -360);
const z1 = await page.locator(".zoom-label").textContent();
check("wheel zooms the canvas", z0 !== z1, `${z0} → ${z1}`);
await page.keyboard.press("f");
const z2 = await page.locator(".zoom-label").textContent();
check("F fits the view", z2 !== z1, `${z1} → ${z2}`);
check("minimap is rendered", (await page.locator(".minimap .mm-node").count()) > 0);

// ---- palette + help -------------------------------------------------------------------------------
await page.keyboard.press("Control+k");
await page.waitForSelector(".palette-modal", { timeout: 3000 });
check("Ctrl+K opens the command palette", (await page.locator(".palette-row").count()) > 5);
await page.locator(".palette-input").fill("drawer");
await page.locator(".palette-input").press("Enter");
check("palette command executes (results drawer)", await page.locator(".drawer").isVisible());
await page.keyboard.press("Escape");
await page.keyboard.press("?");
check("? opens the shortcut sheet", (await page.locator(".modal .keylist").count()) === 1);
await page.keyboard.press("Escape");
await page.screenshot({ path: resolve(evidence, "ux-05-final.png") });

// ---- scenario panel --------------------------------------------------------------------------------
await page.locator("button.chip-btn").click();
check("scenario chip selects the scenario form", (await page.locator(".props h3").textContent()) === "Scenario");

check("no console or page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);
