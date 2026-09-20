import { defineConfig } from "vitest/config";
import path from "node:path";

// P0.1 — no test framework existed in this project before this change
// (no jest/vitest devDependency, no *.test.ts anywhere, no "test" script
// in package.json). vitest was added because the spec's own testing
// section requires "meaningful tests" and explicitly permits introducing
// a framework when none exists ("do not introduce a new testing
// framework unless absolutely necessary"). Zero-config, TS-native, and
// fast — no other project file changes as a result (no babel config, no
// jest config, no test-environment setup beyond this one file).
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      // Next.js `server-only` throws in a non-react-server resolver.
      // AgentKit modules import it as a browser-bundle guard; tests run
      // in Node and need the empty stub.
      "server-only": path.resolve(
        __dirname,
        "lib/architecture/agentkit/__tests__/server-only-stub.ts",
      ),
    },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["node_modules", ".next"],
  },
});
