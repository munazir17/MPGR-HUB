import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");

function source(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

describe("navbar holder badge does not keep chain polls alive", () => {
  it("asks for a one-shot holder tier read and does not mount staking itself", () => {
    const navbar = source("components/Navbar.tsx");
    expect(navbar).toContain("useHolderTier({ poll: false })");
    expect(navbar).not.toContain("useStaking");
    expect(navbar).not.toContain("useTokenLock");
  });

  it("leaves staking and token-lock screens on the default polling cadence", () => {
    const stakingPage = source("app/staking/page.tsx");
    const lockPage = source("app/app/token-lock/page.tsx");
    expect(stakingPage).toContain("useStaking()");
    expect(stakingPage).not.toContain("poll: false");
    expect(lockPage).toContain("useTokenLock()");
    expect(lockPage).not.toContain("poll: false");
  });

  it("gates the repeat reads on the shared policy", () => {
    const staking = source("hooks/useStaking.ts");
    const lock = source("hooks/useTokenLock.ts");
    const tier = source("lib/useHolderTier.ts");
    expect(staking).toContain("shouldPollLiveReads(options)");
    expect(staking).toContain("if (!poll || !isConnected || !address) return;");
    expect(staking).toContain("if (poll) loadGlobalState();");
    expect(staking).toContain(
      "loading: poll ? (isConnected ? !hasLoaded : !globalState) : isConnected && !hasLoaded"
    );
    expect(staking).toContain("MPGR_STAKING_CONFIG.liveReadPollingIntervalMs");
    expect(lock).toContain("if (!poll || !isConnected || !address) return;");
    expect(lock).toContain("MPGR_TOKEN_LOCK_CONFIG.liveReadPollingIntervalMs");
    expect(tier).toContain("useStaking({ poll })");
    expect(tier).toContain("useTokenLock({ poll })");
    expect(tier).toContain("if (!poll || !isConnected || !address) return;");
  });

  it("does not keep the stale unimported holder and premium copies", () => {
    for (const relativePath of [
      "hooks/useHolderTier.ts",
      "hooks/holder-tier-engine.ts",
      "hooks/premium-engine.ts",
    ]) {
      expect(fs.existsSync(path.join(root, relativePath)), relativePath).toBe(false);
    }
  });
});
