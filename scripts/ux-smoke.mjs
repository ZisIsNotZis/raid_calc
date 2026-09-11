import { chromium } from "playwright-core";
const exe = process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell";
const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto("file:///home/z/vibe/raid_calc/raid-calc.html", { waitUntil: "commit" });
await page.waitForTimeout(1000);
const before = await page.locator(".node").count();
await page.locator(".pal", { hasText: "Pool" }).click();
const after = await page.locator(".node").count();
const disk = page.locator(".node", { hasText: "DISK" }).first();
await disk.click();
const cap = page.locator(".props input").first();
const initial = await cap.inputValue();
await cap.fill("10"); await cap.press("Enter");
await page.locator(".node", { hasText: "OUTPUT" }).click(); await disk.click();
const persisted = await page.locator(".props input").first().inputValue();
await page.reload({ waitUntil: "commit" }); await page.waitForTimeout(1000);
await page.locator(".node", { hasText: "DISK" }).first().click();
const reset = await page.locator(".props input").first().inputValue();
await page.locator("button.primary").click({ noWaitAfter: true }).catch(() => {});
for (let i=0;i<60;i++){await page.waitForTimeout(1000);if(await page.locator("svg path").count()>4)break;}
const result = {
  canvas: await page.locator("main.canvas").evaluate((e)=>{const r=e.getBoundingClientRect();return {w:Math.round(r.width),h:Math.round(r.height)}}),
  nodesAdded: [before,after], field: {initial,persisted,afterRefresh:reset},
  paths: await page.locator("svg path").count(), errors,
};
console.log(JSON.stringify(result,null,1));
await page.screenshot({path:".scratch/01-raid-calc/evidence/ux-smoke.png"});
await browser.close();
