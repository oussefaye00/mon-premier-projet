// node probe.js out/probe 0.6 1.8 ...   -> one PNG per time (1080x1920)
const { chromium } = require("playwright");
const path = require("path"), fs = require("fs");
(async () => {
  const [dir, ...times] = process.argv.slice(2);
  fs.mkdirSync(dir, { recursive: true });
  const b = await chromium.launch({ args: ["--force-color-profile=srgb", "--font-render-hinting=none"] });
  const p = await b.newPage({ viewport: { width: 1080, height: 1920 } });
  await p.goto("file://" + path.resolve(__dirname, "film.html"));
  await p.waitForFunction(() => window.ready === true);
  for (const t of times) {
    await p.evaluate(async (t) => { await window.seek(t); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); }, parseFloat(t));
    await p.locator("canvas").screenshot({ path: `${dir}/t${parseFloat(t).toFixed(2)}.png` });
  }
  await b.close();
})();
