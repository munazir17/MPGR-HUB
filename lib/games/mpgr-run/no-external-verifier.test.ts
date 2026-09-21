// lib/games/mpgr-run/no-external-verifier.test.ts
//
// Regression: ensure no code path attempts to call an external verifier
// via GAME_RUN_VERIFIER_URL/SECRET. The authoritative mechanism is the
// in-process deterministic replay, not an external service.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("no external verifier wiring", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("gameRewardsAreOperatorEnabled does not require GAME_RUN_VERIFIER_URL/SECRET", async () => {
    delete process.env.GAME_RUN_VERIFIER_URL;
    delete process.env.GAME_RUN_VERIFIER_SECRET;
    process.env.GAME_REWARDS_ENABLED = "true";
    process.env.GAME_AUTHORITATIVE_VERIFICATION_ENABLED = "true";
    // Force re-import to read fresh env
    vi.resetModules();
    const mod = await import("@/lib/games/games-reward-config");
    expect(mod.gameRewardsAreOperatorEnabled()).toBe(true);
    // Ensure the old helper is gone
    expect((mod as any).authoritativeGameVerifierIsConfigured).toBeUndefined();
  });

  it("no source file in lib/ or app/ reads external verifier env vars as runtime config", async () => {
    // Walk lib and app for forbidden runtime access, excluding docs and this test.
    // Historical comments mentioning the old var names are allowed, but
    // process.env.GAME_RUN_VERIFIER_URL / SECRET must not be read as config.
    const forbiddenPatterns = ["process.env.GAME_RUN_VERIFIER_URL", "process.env.GAME_RUN_VERIFIER_SECRET"];
    const roots = ["lib/games", "lib/reward-allocation", "app/api/games"];
    for (const root of roots) {
      const absRoot = path.join(process.cwd(), root);
      const files = walk(absRoot);
      for (const file of files) {
        if (file.endsWith(".test.ts")) continue;
        if (file.includes("no-external-verifier")) continue;
        const content = fs.readFileSync(file, "utf8");
        for (const pattern of forbiddenPatterns) {
          if (content.includes(pattern)) {
            throw new Error(`Forbidden runtime reference to ${pattern} found in ${file}. External verifier wiring must be removed.`);
          }
        }
      }
    }
  });

  it("reward route does not call fetch to external verifier", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    // Import reward route after mocking fetch — it should not call fetch at import time
    vi.resetModules();
    await import("@/app/api/games/mpgr-run/reward/route");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("settlement route does not call fetch to external verifier at import time", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    vi.resetModules();
    await import("@/app/api/games/mpgr-run/settlement/route");
    // Settlement may call fetch for on-chain RPC, but not for verifier URL
    // So we check that no call contains verifier URL
    for (const call of fetchSpy.mock.calls) {
      const url = String(call[0] ?? "");
      if (url.includes("verifier")) {
        throw new Error(`Unexpected fetch to verifier URL: ${url}`);
      }
    }
  });
});

function walk(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walk(full));
    } else if (entry.isFile() && (full.endsWith(".ts") || full.endsWith(".js"))) {
      results.push(full);
    }
  }
  return results;
}
