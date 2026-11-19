import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  resolve: {
    alias: {
      "@amai/core": r("./packages/core/src/index.ts"),
      "@amai/renderer": r("./packages/renderer/src/index.ts"),
      "@amai/ai": r("./packages/ai/src/index.ts"),
      "@amai/bridge": r("./packages/bridge/src/index.ts"),
    },
  },
  test: { include: ["packages/*/test/**/*.test.ts"], testTimeout: 30000 },
});
