import { defineConfig } from "vite";
import path from "node:path";
export default defineConfig({
  root: path.resolve(__dirname),
  resolve: { alias: [{ find: "@", replacement: path.resolve(__dirname, "../..") }, { find: /^wagmi$/, replacement: path.resolve(__dirname, "wallet.tsx") }] },
  oxc: { jsx: { runtime: "automatic" } },
  server: { host: "0.0.0.0", port: 4173, strictPort: true, allowedHosts: [".e2b.app"] },
});
