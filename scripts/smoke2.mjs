import { chromium } from "playwright-core";
const exe = process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell";
const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message.slice(0, 200)));
page.on("console", (m) => { if (m.type() === "error") errors.push("[err] " + m.text().slice(0, 200)); });
await page.goto("file:///home/z/vibe/raid_calc/raid-calc.html", { waitUntil: "commit", timeout: 30000 });
await page.waitForTimeout(5000);
const state = await page.evaluate(() => ({
  children: document.getElementById("app")?.childElementCount,
  runDisabled: document.querySelector("button.primary")?.classList.contains("disabled"),
  runTitle: document.querySelector("button.primary")?.title?.slice(0, 80),
  textLen: document.body.innerText.length,
}));
console.log(JSON.stringify({ state, errors }, null, 1));
await browser.close();
