import { chromium } from "playwright-core";
const exe = process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell";
const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto("file:///home/z/vibe/raid_calc/raid-calc.html", { waitUntil: "commit" });
await page.waitForTimeout(2500);
await page.evaluate(() => document.querySelector("button.primary").click());
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(1000);
  if (await page.evaluate(() => document.querySelectorAll("svg path").length > 4)) break;
}
await page.screenshot({ path: ".scratch/01-raid-calc/evidence/ui-screenshot.png" });
console.log("shot saved, charts:", await page.evaluate(() => document.querySelectorAll("svg path").length));
await browser.close();
