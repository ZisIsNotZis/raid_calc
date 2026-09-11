import { chromium } from "playwright-core";
const exe = process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell";
const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message.slice(0, 300)));
page.on("console", (m) => { if (m.type() === "error") errors.push("[err] " + m.text().slice(0, 200)); });
await page.goto("file:///home/z/vibe/raid_calc/raid-calc.html", { waitUntil: "commit", timeout: 30000 });
await page.waitForTimeout(2000);
// click Run and wait for the multi-minute CTMC solve
await page.evaluate(() => document.querySelector("button.primary").click()); // solve blocks the main thread for minutes
await page.waitForTimeout(300000);
const after = await page.evaluate(() => ({
  chartNodes: document.querySelectorAll("svg").length,
  paths: document.querySelectorAll("svg path").length,
  summaryRows: document.querySelectorAll(".result-summary .row, .inventory .row").length,
  outputText: (document.querySelector(".out-charts")?.textContent || "").slice(0, 200),
}));
console.log(JSON.stringify({ after, errors }, null, 1));
await page.screenshot({ path: ".tmp/smoke-after-run.png", fullPage: false });
await browser.close();
