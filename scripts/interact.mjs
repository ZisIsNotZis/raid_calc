import { chromium } from "playwright-core";
const exe = process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell";
const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message.slice(0, 200)));
await page.goto("file:///home/z/vibe/raid_calc/raid-calc.html", { waitUntil: "commit" });
await page.waitForTimeout(2000);

// 1. click the "Pool" palette item — does a node appear?
const before = await page.evaluate(() => document.querySelectorAll(".node").length);
await page.click("text=Pool");
await page.waitForTimeout(300);
const after = await page.evaluate(() => document.querySelectorAll(".node").length);
console.log("palette Pool click: nodes before", before, "after", after);

// 2. where are the nodes positioned? (viewport vs off-screen)
const pos = await page.evaluate(() =>
  [...document.querySelectorAll(".node")].slice(0, 6).map((n) => {
    const r = n.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), label: (n.innerText || "").slice(0, 20) };
  }),
);
console.log("node positions:", JSON.stringify(pos, null, 1));

// 3. canvas visible size
const cv = await page.evaluate(() => {
  const c = document.querySelector("main.canvas, .canvas");
  const r = c ? c.getBoundingClientRect() : null;
  return r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : "NO CANVAS ELEMENT";
});
console.log("canvas rect:", JSON.stringify(cv));

// 4. field persistence: click the disk node, type a new capacity, click elsewhere, come back
await page.click("text=hdd8");
await page.waitForTimeout(300);
const capInput = page.locator(".props input").first();
await capInput.fill("10");
await capInput.press("Enter");
await page.waitForTimeout(200);
await page.click("text=Pool");
await page.waitForTimeout(300);
await page.click("text=hdd8");
await page.waitForTimeout(300);
const capNow = await page.locator(".props input").first().inputValue();
console.log("capacity after edit + reselect:", capNow);
console.log("errors:", errors);
await page.screenshot({ path: ".tmp/interact.png" });
await browser.close();
