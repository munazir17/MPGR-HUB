import { defineConfig } from "vite";
import path from "node:path";
export default defineConfig({
  root: path.resolve(__dirname),
  publicDir: path.resolve(__dirname, "../../public"),
  resolve: { alias: [{ find: /^next\/navigation$/, replacement: path.resolve(__dirname, "router.ts") },{ find: /^viem\/op-stack$/, replacement: path.resolve(__dirname, "gas-actions.ts") },{ find: /^@rainbow-me\/rainbowkit$/, replacement: path.resolve(__dirname, "connect-modal.ts") },{ find: /^wagmi\/actions$/, replacement: path.resolve(__dirname, "wallet-actions.ts") }, { find: "@/lib/wagmi", replacement: path.resolve(__dirname, "wallet-actions.ts") }, { find: "@", replacement: path.resolve(__dirname, "../..") }, { find: /^wagmi$/, replacement: path.resolve(__dirname, "wallet.tsx") }] },
  oxc: { jsx: { runtime: "automatic" } },
  server: { host: "0.0.0.0", port: 4173, strictPort: true, allowedHosts: [".e2b.app"] },
});
