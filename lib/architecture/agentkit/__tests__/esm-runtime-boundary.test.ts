import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Regression coverage for the production ERR_REQUIRE_ESM failure in
 * POST /api/agentkit/invoke.
 *
 * AgentKit and its CDP stack are listed in next.config.mjs
 * `serverExternalPackages`, so Next does NOT bundle them: the built route
 * does a plain CommonJS `require("@coinbase/agentkit")` at request time
 * and Node resolves the whole dependency chain from node_modules. If any
 * CJS file in that chain does a synchronous `require()` of an ESM-only
 * package, it throws ERR_REQUIRE_ESM before the route handler can run.
 *
 * Node's `require(esm)` interop (on by default in 20.19+/22.12+/24)
 * hides this locally and in vitest, but it is not active on Vercel's
 * serverless Node runtime. Running each external package through
 * `node --no-experimental-require-module` reproduces the Vercel
 * condition exactly and independently of the host Node version.
 *
 * Boundaries this guards (all reproduced on origin/main before the fix):
 *   rpc-websockets@9.3.9 (via @solana/web3.js) -> uuid@14   ESM-only
 *   @coinbase/agentkit -> @across-protocol/app-sdk           "type":"module"
 *   @coinbase/agentkit -> @base-org/account/spend-permission "type":"module"
 *   @coinbase/agentkit -> clanker-sdk/v4                     "type":"module"
 *   @coinbase/cdp-sdk  -> jose@6                             ESM-only
 * The first is fixed by an `overrides` pin; the rest are rewritten to
 * lazy `import()` by scripts/fix-cdp-jose-esm.cjs on postinstall.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const NODE_MODULES = path.join(REPO_ROOT, "node_modules");
const nodeRequire = createRequire(path.join(REPO_ROOT, "package.json"));

// Keep in sync with next.config.mjs `serverExternalPackages`.
const SERVER_EXTERNAL_PACKAGES = [
  "@coinbase/agentkit",
  "@coinbase/coinbase-sdk",
  "@coinbase/x402",
  "@coinbase/cdp-sdk",
] as const;

function runInStrictCjsRuntime(script: string) {
  return spawnSync(
    process.execPath,
    ["--no-experimental-require-module", "-e", script],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "" },
      timeout: 120_000,
    },
  );
}

function requireInStrictCjsRuntime(specifier: string) {
  return runInStrictCjsRuntime(
    [
      `try { require(${JSON.stringify(specifier)}); process.stdout.write("LOADED"); }`,
      `catch (e) { process.stdout.write("FAILED " + (e && e.code ? e.code : "") + " " + (e && e.message ? e.message.split("\\n")[0] : String(e))); process.exit(1); }`,
    ].join("\n"),
  );
}

function readPackageJson(pkgDir: string) {
  return JSON.parse(
    fs.readFileSync(path.join(NODE_MODULES, pkgDir, "package.json"), "utf8"),
  ) as { version: string; dependencies?: Record<string, string> };
}

describe("AgentKit CommonJS runtime boundary (Vercel Node without require(esm))", () => {
  it("next.config.mjs serverExternalPackages list is unchanged", async () => {
    const config = (await import("../../../../next.config.mjs")).default as {
      serverExternalPackages?: string[];
    };
    expect(config.serverExternalPackages).toEqual([
      ...SERVER_EXTERNAL_PACKAGES,
    ]);
  });

  for (const pkg of SERVER_EXTERNAL_PACKAGES) {
    it(`${pkg} loads without ERR_REQUIRE_ESM`, () => {
      const result = requireInStrictCjsRuntime(pkg);
      expect(
        result.stdout,
        `${pkg} failed to load in a strict CJS runtime:\n${result.stdout}\n${result.stderr}`,
      ).toBe("LOADED");
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain("ERR_REQUIRE_ESM");
    });
  }

  it("rpc-websockets (via @solana/web3.js) no longer depends on an ESM-only uuid", () => {
    // The specific boundary that broke production. rpc-websockets >= 9.3.10
    // uses crypto.randomUUID() and has no uuid dependency at all. The
    // package has no "./package.json" export, so read it from disk.
    const pkgJson = readPackageJson("rpc-websockets");
    expect(pkgJson.dependencies?.uuid).toBeUndefined();
    expect(
      fs.existsSync(path.join(NODE_MODULES, "rpc-websockets", "node_modules", "uuid")),
    ).toBe(false);

    const result = requireInStrictCjsRuntime("rpc-websockets");
    expect(result.stdout, result.stdout + result.stderr).toBe("LOADED");
  });

  it("postinstall rewrite leaves no synchronous require of an ESM-only package in agentkit/cdp-sdk", () => {
    const agentkitDist = path.join(NODE_MODULES, "@coinbase", "agentkit", "dist");
    const cdpCjs = path.join(NODE_MODULES, "@coinbase", "cdp-sdk", "_cjs");

    const offenders: string[] = [];
    const walk = (dir: string, re: RegExp) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, re);
        else if (
          entry.isFile() &&
          entry.name.endsWith(".js") &&
          !entry.name.endsWith(".test.js") &&
          re.test(fs.readFileSync(full, "utf8"))
        ) {
          offenders.push(path.relative(NODE_MODULES, full));
        }
      }
    };

    walk(
      agentkitDist,
      /require\(\s*["'](?:@across-protocol\/app-sdk|@base-org\/account\/spend-permission|clanker-sdk\/v4)["']\s*\)/,
    );
    walk(cdpCjs, /require\(\s*["']jose["']\s*\)/);

    expect(offenders).toEqual([]);
  });

  it("the lazily-loaded providers still resolve their real modules at call time", () => {
    // The rewrite must not just make the file parse — the deferred
    // import() has to deliver the same exports the original synchronous
    // require() did, otherwise a provider that used to work would now
    // throw "x is not a function" the first time it is invoked.
    const result = runInStrictCjsRuntime(`
      const path = require("path");
      const dist = path.join(process.cwd(), "node_modules", "@coinbase", "agentkit", "dist", "action-providers");
      (async () => {
        // Requiring the rewritten files must succeed synchronously (that is
        // the whole point) and must still export the same public surface.
        const clanker = require(path.join(dist, "clanker", "utils.js"));
        const acrossMod = require(path.join(dist, "across", "acrossActionProvider.js"));
        const baseAccount = require(path.join(dist, "baseAccount", "baseAccountActionProvider.js"));
        if (typeof clanker.createClankerClient !== "function") throw new Error("clanker utils export missing");
        if (typeof acrossMod.AcrossActionProvider !== "function") throw new Error("AcrossActionProvider export missing");
        if (typeof baseAccount.BaseAccountActionProvider !== "function") throw new Error("BaseAccountActionProvider export missing");
        // And the deferred import() each rewrite performs must resolve to
        // the real ESM module with the symbols the provider code calls.
        const across = await import("@across-protocol/app-sdk");
        const spend = await import("@base-org/account/spend-permission");
        const v4 = await import("clanker-sdk/v4");
        if (typeof across.createAcrossClient !== "function") throw new Error("across missing");
        if (typeof spend.fetchPermissions !== "function") throw new Error("spend-permission missing");
        if (typeof v4.Clanker !== "function") throw new Error("clanker missing");
        process.stdout.write("RESOLVED");
      })().catch((e) => { process.stdout.write("FAILED " + (e && e.code ? e.code + " " : "") + (e && e.message ? e.message.split("\\n")[0] : String(e))); process.exit(1); });
    `);
    expect(result.stdout, result.stdout + result.stderr).toBe("RESOLVED");
  });
});
