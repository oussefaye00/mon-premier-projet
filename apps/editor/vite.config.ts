import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@amai/core": r("../../packages/core/src/index.ts"),
      "@amai/renderer": r("../../packages/renderer/src/index.ts"),
      "@amai/ai": r("../../packages/ai/src/index.ts"),
      "@amai/bridge": r("../../packages/bridge/src/index.ts"),
    },
  },
  build: { target: "es2022", sourcemap: true, chunkSizeWarningLimit: 1500 },
  server: { port: 5173, host: "127.0.0.1" },
  preview: { port: 4173, host: "127.0.0.1" },
});
