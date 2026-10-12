// Screenshot a rendered sample at phone and desktop widths.
// Usage: node previews.cjs <dir with index.html> <out prefix>
const { chromium } = require("playwright-core");
const fs = require("fs"), path = require("path"), os = require("os");
function chrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const base = path.join(os.homedir(), "Library/Caches/ms-playwright");
  for (const d of fs.existsSync(base) ? fs.readdirSync(base).filter((x) => x.startsWith("chromium-")).sort().reverse() : []) {
    const p = path.join(base, d, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
    if (fs.existsSync(p)) return p;
  }
  return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
}
(async () => {
  const [dir, prefix] = process.argv.slice(2);
  const b = await chromium.launch({ executablePath: chrome() });
  for (const [label, w, h] of [["phone", 390, 844], ["desktop", 1280, 800]]) {
    const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
    await p.goto("file://" + path.resolve(dir, "index.html"), { waitUntil: "networkidle" });
    await p.screenshot({ path: `${prefix}-${label}.png` });
    await p.close();
  }
  await b.close();
})();
