// Ticket 13: bundle src/ui/main.js (+ imports) into a single self-contained raid-calc.html.
// The bundle REPLACES the dev shell's module script and appends the bootstrap call, so the
// artifact self-starts (the dev page's explicit createApp() call is not preserved by esbuild).
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";

const result = await build({
  entryPoints: ["src/ui/main.js"],
  bundle: true,
  minify: false,
  format: "esm",
  write: false,
});
const js = result.outputFiles[0].text;
const shell = readFileSync("index.html", "utf8");
const marker = '<script type="module">';
if (!shell.includes(marker)) throw new Error('index.html: expected a <script type="module"> block to replace');
const start = shell.indexOf(marker);
const end = shell.indexOf("</script>", start) + "</script>".length;
const escapeScript = (s) => s.replaceAll("</script>", "<\\/script>");
const bundled =
  shell.slice(0, start) +
  marker +
  "\n" +
  escapeScript(js) +
  "\n</script>\n" +
  shell.slice(end);
if (/from\s+["'](?!\.)(?!data:)(?!https?:)/.test(js)) {
  throw new Error("bundle contains unresolved external imports");
}
writeFileSync("raid-calc.html", bundled);
console.log(`raid-calc.html written (${(bundled.length / 1024).toFixed(0)} KB)`);
