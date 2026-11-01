// node render.js <outDir> <firstFrame> <lastFrameExclusive> [fps=60] [sub=6] [scale=1]
// Each output frame = average of `sub` seek(t) samples spread over a 180° shutter (half a frame).
const { chromium } = require("playwright");
const path = require("path"), fs = require("fs");
(async () => {
  const [dir, a, b, fpsS = "60", subS = "6", scaleS = "1"] = process.argv.slice(2);
  const FPS = +fpsS, SUB = +subS, SHUTTER = 0.5, SCALE = +scaleS;
  fs.mkdirSync(dir, { recursive: true });
  const br = await chromium.launch({ args: ["--force-color-profile=srgb", "--font-render-hinting=none", "--disable-threaded-animation", "--run-all-compositor-stages-before-draw"] });
  const p = await br.newPage({ viewport: { width: 1080, height: 1920 } });
  await p.goto("file://" + path.resolve(__dirname, "film.html"));
  await p.waitForFunction(() => window.ready === true);
  await p.evaluate(() => {
    const c = document.getElementById("c"), ctx = c.getContext("2d", { willReadFrequently: true });
    const out = document.createElement("canvas"); out.width = c.width; out.height = c.height;
    const octx = out.getContext("2d");
    const acc = new Float32Array(c.width * c.height * 4);
    // returns a JPEG data URL of the motion-blurred frame
    window.frame = async (times, scale) => {
      acc.fill(0);
      for (const t of times) {
        await window.seek(t);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        for (let i = 0; i < d.length; i++) acc[i] += d[i];
      }
      const img = octx.createImageData(c.width, c.height), n = times.length;
      for (let i = 0; i < acc.length; i++) img.data[i] = acc[i] / n + 0.5;
      octx.putImageData(img, 0, 0);
      let src = out;
      if (scale !== 1) {
        src = document.createElement("canvas"); src.width = c.width * scale; src.height = c.height * scale;
        const s = src.getContext("2d"); s.imageSmoothingQuality = "high"; s.drawImage(out, 0, 0, src.width, src.height);
      }
      return src.toDataURL("image/png");
    };
  });
  for (let f = +a; f < +b; f++) {
    const times = [];
    const tf = f / FPS, n = SUB > 1 && ((tf > 9.1 && tf < 9.5) || (tf > 4.55 && tf < 5.2)) ? 16 : SUB; // dense samples on the flood + contraction
    for (let s = 0; s < n; s++) times.push((f + (n === 1 ? 0 : (s / n - 0.5) * SHUTTER)) / FPS);
    const url = await p.evaluate(([ts, sc]) => window.frame(ts.map(x => Math.max(0, x)), sc), [times, SCALE]);
    fs.writeFileSync(`${dir}/f${String(f).padStart(5, "0")}.png`, Buffer.from(url.split(",")[1], "base64"));
  }
  await br.close();
})();
