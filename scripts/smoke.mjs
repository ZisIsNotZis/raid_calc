import { chromium } from "playwright-core";
const exe = process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell";
const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push("PAGEERROR: " + (e.stack || e.message).slice(0, 700)));
page.on("console", (m) => { if (m.type() === "error") errors.push("[err] " + m.text().slice(0, 200)); });
await page.goto("file:///home/z/vibe/raid_calc/raid-calc.html", { waitUntil: "commit", timeout: 30000 });
await page.waitForTimeout(2000);
// click Run and wait for the multi-minute CTMC solve
await page.evaluate(() => document.querySelector("button.primary").click());
// poll until charts render (the solve takes seconds with collapsed stages)
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(1000);
  const paths = await page.evaluate(() => document.querySelectorAll("svg path").length);
  if (paths > 0) break;
}
const after = await page.evaluate(() => ({
  chartNodes: document.querySelectorAll("svg").length,
  paths: document.querySelectorAll("svg path").length,
  canvasNodes: document.querySelectorAll(".node").length,
  canvasWires: document.querySelectorAll(".wires path, svg.wires *").length,
  propsFields: document.querySelectorAll(".props .field").length,
  canvasText: (document.querySelector("main.canvas")?.innerText || "").slice(0, 150),
}));
console.log(JSON.stringify({ after, errors }, null, 1));
await page.screenshot({ path: ".tmp/smoke-after-run.png", fullPage: false });
await browser.close();
