import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const r = (p) => fileURLToPath(new URL(p, import.meta.url));
await build({
  entryPoints: [r("./src/index.ts")],
  outfile: r("./dist/index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  alias: {
    "@amai/core": r("../core/src/index.ts"),
    "@amai/bridge": r("../bridge/src/index.ts"),
  },
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
});
