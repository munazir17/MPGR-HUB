import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdtempSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Regression suite for the TRUSTED-CODE swap-executor deployment architecture:
//   - PR-side workflow (deploy-swap-executor-base-mainnet.yml): gates/rehearsal
//     ONLY, structurally incapable of deployment, zero production secrets.
//   - Trusted workflow (deploy-swap-executor-trusted.yml): dispatch-from-main
//     only, executes the owner-pinned SHA (repo variable SWAP_DEPLOY_REF)
//     verified BEFORE any secret is in scope, reviewer-protected environment.
//   - Fail-closed behaviour proven OFFLINE by executing the real scripts.
//     The one authorized deployment has happened (trusted workflow run
//     39205622603; executor 0xBC4dE809b4b72bCe8f61c87daC6Be12e3F7c6b3E, block
//     52799525) and the sealed final manifest is committed, so the
//     regressions below prove all three halves of the consumed pipeline:
//     (a) in the committed tree, every guard now refuses a SECOND deployment
//         before any RPC call, and the sealed record is never mutated;
//     (b) the pre-deployment staging/finalize guards are unchanged, exercised
//         against a throwaway `git worktree` whose scratch copy of the final
//         manifest is removed; and
//     (c) the gate-CLOSED path is unchanged, exercised against a throwaway
//         `git worktree` so no test ever writes to the committed config.
// Runs without network, without anvil, and without secrets.

const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as { load: (text: string) => unknown };

const prWorkflowText = readFileSync(".github/workflows/deploy-swap-executor-base-mainnet.yml", "utf8");
const trustedText = readFileSync(".github/workflows/deploy-swap-executor-trusted.yml", "utf8");
const forkWorkflowText = readFileSync(".github/workflows/swap-fork-tests-base-mainnet.yml", "utf8");
const legacyWorkflowText = readFileSync(".github/workflows/deploy-executor-base-mainnet.yml", "utf8");
const deployConfig = JSON.parse(readFileSync("deployments/base-mainnet/deploy-config.json", "utf8"));
const libConfigText = readFileSync("lib/swap/swap-executor-config.ts", "utf8");
const contractText = readFileSync("contracts/swap/MPGRSwapExecutor.sol", "utf8");
const preflightSh = readFileSync("scripts/swap-deploy/preflight.sh", "utf8");
const rehearseSh = readFileSync("scripts/swap-deploy/rehearse.sh", "utf8");
const safeCheckSh = readFileSync("scripts/swap-deploy/safe-check.sh", "utf8");
const deployScript = readFileSync("script/DeployMPGRSwapExecutorBaseMainnet.s.sol", "utf8");
const codeowners = readFileSync(".github/CODEOWNERS", "utf8");

type Step = { name?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Job = { if?: string; needs?: string | string[]; environment?: string | { name: string }; outputs?: Record<string, string>; steps?: Step[] };
type Workflow = { on?: unknown; jobs?: Record<string, Job> };
const prWorkflow = yaml.load(prWorkflowText) as Workflow;
const trusted = yaml.load(trustedText) as Workflow;

const CFG = "deployments/base-mainnet/deploy-config.json";
const STAGING = "deployments/base-mainnet/mpgr-swap-executor.staging.json";
const FINAL = "deployments/base-mainnet/mpgr-swap-executor.json";
const SECRET = "SWAP_BASE_MAINNET_DEPLOYER_PRIVATE_KEY";
// Public, well-known throwaway values: never a real key, owner or endpoint.
const DUMMY_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";
const DUMMY_OWNER = "0x0000000000000000000000000000000000000001";
const UNREACHABLE_RPC = "https://invalid.example";

function runExpectFail(cmd: string, args: string[], env: Record<string, string>, cwd = process.cwd()): string {
  try {
    const out = execFileSync(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 180_000,
    });
    throw new Error(`expected failure but command succeeded: ${out.slice(0, 200)}`);
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    if (err.message?.startsWith("expected failure but command succeeded")) throw e;
    return `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
}

/**
 * Runs `fn` against a THROWAWAY detached `git worktree` of HEAD whose copy of
 * deploy-config.json has the swap gate forced back to `false`. The committed,
 * CODEOWNER-protected config is never written to, so the gate-CLOSED
 * fail-closed paths keep their behavioural coverage now that the reviewed
 * gate is open. The worktree is always removed, even on failure.
 */
function withClosedGateWorktree<T>(fn: (dir: string) => T): T {
  const base = mkdtempSync(join(tmpdir(), "swap-closed-gate-"));
  const tree = join(base, "tree");
  execFileSync("git", ["worktree", "add", "--detach", "--quiet", tree, "HEAD"], { stdio: "ignore" });
  try {
    const cfg = JSON.parse(readFileSync(join(tree, CFG), "utf8"));
    cfg.swapExecutorDeployEnabled = false;
    writeFileSync(join(tree, CFG), `${JSON.stringify(cfg, null, 2)}\n`);
    return fn(tree);
  } finally {
    execFileSync("git", ["worktree", "remove", "--force", tree], { stdio: "ignore" });
    rmSync(base, { recursive: true, force: true });
  }
}

/**
 * Runs `fn` against a THROWAWAY detached `git worktree` of HEAD with the
 * scratch copy of the sealed final manifest removed (the committed gate stays
 * the reviewed OPEN authorization). The pre-deployment staging/finalize
 * guards can only be reached in a tree without the final manifest, because in
 * the committed tree the manifest itself refuses everything downstream. The
 * committed manifest is never written to; the worktree is always removed.
 */
function withNoManifestWorktree<T>(fn: (dir: string) => T): T {
  const base = mkdtempSync(join(tmpdir(), "swap-no-manifest-"));
  const tree = join(base, "tree");
  execFileSync("git", ["worktree", "add", "--detach", "--quiet", tree, "HEAD"], { stdio: "ignore" });
  try {
    rmSync(join(tree, FINAL), { force: true });
    rmSync(join(tree, STAGING), { force: true });
    return fn(tree);
  } finally {
    execFileSync("git", ["worktree", "remove", "--force", tree], { stdio: "ignore" });
    rmSync(base, { recursive: true, force: true });
  }
}

// The sealed deployment record is committed; its exact bytes are pinned so
// that NO test (and no script a test executes) can ever mutate it silently.
const SEALED_MANIFEST_BYTES = readFileSync(FINAL, "utf8");

afterEach(() => {
  // No test may ever leave deployment side effects behind: the sealed final
  // manifest must survive byte-identical and no staging record may linger.
  expect(existsSync(FINAL), "sealed final manifest must exist during tests").toBe(true);
  expect(readFileSync(FINAL, "utf8"), "sealed final manifest must never be mutated by tests").toBe(SEALED_MANIFEST_BYTES);
  if (existsSync(STAGING)) rmSync(STAGING);
});

describe("committed production gates are exactly the reviewed state", () => {
  it("pins the reviewed swapExecutorDeployEnabled=true authorization and keeps mainnetDeployEnabled=false", () => {
    expect(deployConfig.chainId).toBe(8453);
    // Reviewed, merged owner authorization for AT MOST ONE deployment attempt.
    // It stays the JSON boolean true (never a string/absent) as the record of
    // that authorization, and it must not relax anything else: the legacy
    // executor gate stays closed. The authorization is now CONSUMED (see the
    // routing/manifest assertions below): the committed sealed manifest makes
    // preflight and the deploy script refuse any second attempt regardless.
    expect(deployConfig.swapExecutorDeployEnabled).toBe(true);
    expect(deployConfig.mainnetDeployEnabled).toBe(false);
  });
  it("records the one consumed deployment and never implies another broadcast is authorized", () => {
    const c = String(deployConfig._swapComment);
    expect(c).toContain("DEPLOYED and CONSUMED");
    expect(c).toContain("0xBC4dE809b4b72bCe8f61c87daC6Be12e3F7c6b3E");
    expect(c).toContain("0x549a54c25a31c0fd47dff625bdfba821c27d892b5cb437473b1decc751efa4cc");
    expect(c).toContain("52799525");
    // The record must be explicit that the open gate can never authorize a
    // second broadcast while the sealed manifest exists.
    expect(c).toMatch(/can never authorize another broadcast/i);
  });
  it("pins the activated routing constant to the sealed manifest and keeps the manifest on disk", () => {
    expect(libConfigText).toContain('executor: "0xBC4dE809b4b72bCe8f61c87daC6Be12e3F7c6b3E"');
    expect(libConfigText).toContain('deployTx: "0x549a54c25a31c0fd47dff625bdfba821c27d892b5cb437473b1decc751efa4cc"');
    expect(libConfigText).toContain("deployBlock: 52799525");
    expect(libConfigText).not.toContain("export const SWAP_PATH_EXECUTOR_DEPLOYMENT: SwapPathExecutorDeployment | null = null;");
    expect(existsSync(FINAL)).toBe(true);
    expect(existsSync(STAGING)).toBe(false);
    const manifest = JSON.parse(SEALED_MANIFEST_BYTES) as {
      chainId: number; executor: string; deployTx: string; deployBlock: number; owner: string; deployer: string;
      feeBps: number; maxFeeBps: number; feeTimelockSeconds: number; venues: unknown[];
    };
    expect(manifest.chainId).toBe(8453);
    expect(manifest.executor).toBe("0xBC4dE809b4b72bCe8f61c87daC6Be12e3F7c6b3E");
    expect(manifest.deployTx).toBe("0x549a54c25a31c0fd47dff625bdfba821c27d892b5cb437473b1decc751efa4cc");
    expect(manifest.deployBlock).toBe(52799525);
    expect(manifest.owner).toBe("0xd9aE570767C5a15780DD5cdAdd0b1b732D98994B");
    expect(manifest.owner.toLowerCase()).not.toBe(manifest.deployer.toLowerCase());
    expect(manifest.feeBps).toBe(deployConfig.feeBps);
    expect(manifest.maxFeeBps).toBe(deployConfig.maxFeeBps);
    expect(manifest.feeTimelockSeconds).toBe(172800);
    expect(manifest.venues).toHaveLength(5);
  });
  it("cannot emit the old placeholder and actively guards against it", () => {
    expect(deployScript).not.toContain("pending-record");
    expect(preflightSh).not.toContain("pending-record");
    const finalizeSh = readFileSync("scripts/swap-deploy/finalize-manifest.sh", "utf8");
    expect(finalizeSh).toContain("grep -q 'pending-record'");
    expect(rehearseSh).toContain("grep -q 'pending-record'");
  });
});

describe("fee policy pins are consistent across config, lib and contract", () => {
  it("25 bps initial, 100 bps cap, 48h timelock, pinned treasury recipient", () => {
    expect(deployConfig.feeBps).toBe(25);
    expect(deployConfig.maxFeeBps).toBe(100);
    const recipient = "0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4";
    expect(deployConfig.feeRecipient).toBe(recipient);
    expect(libConfigText).toContain(`export const SWAP_FEE_RECIPIENT: Address = "${recipient}";`);
    expect(deployScript).toContain(`address internal constant FEE_RECIPIENT_PIN = ${recipient};`);
    expect(deployScript).toContain("uint16 internal constant INITIAL_FEE_BPS = 25;");
    expect(contractText).toContain("uint16 public constant MAX_FEE_BPS = 100;");
    expect(contractText).toContain("uint48 public constant FEE_TIMELOCK_SECONDS = 48 hours;");
  });
});

describe("PR-side workflow is gates-only and structurally incapable of deployment", () => {
  it("triggers only on the dedicated label from the same repository", () => {
    const on = (prWorkflow.on ?? (prWorkflow as Record<string, unknown>).true) as Record<string, unknown>;
    expect(Object.keys(on)).toEqual(["pull_request"]);
    expect(prWorkflowText).toContain("deploy-swap-base-mainnet");
    expect(prWorkflowText).toContain("head.repo.full_name == github.repository");
  });
  it("scopes concurrency to the PR head so stale runs can never block a new head", () => {
    const group = String((prWorkflow as unknown as { concurrency?: { group?: string } }).concurrency?.group ?? "");
    expect(group).toContain("github.event.pull_request.head.sha");
    expect(prWorkflowText).toContain("cancel-in-progress: false");
  });
  it("has NO environment and NO production secret anywhere in the file", () => {
    for (const [name, job] of Object.entries(prWorkflow.jobs!)) {
      expect(job.environment, `job ${name} must not declare an environment`).toBeUndefined();
    }
    expect(prWorkflowText).not.toContain(SECRET);
    expect(prWorkflowText).not.toContain("--broadcast"); // rehearsal broadcasts via rehearse.sh to local anvil only
    expect(prWorkflowText).toContain("rehearse.sh");
  });
  it("keeps the fork-tests workflow read-only and the legacy workflow quarantined", () => {
    expect(forkWorkflowText).not.toContain("--broadcast");
    expect(forkWorkflowText).not.toContain("PRIVATE_KEY");
    expect(legacyWorkflowText).not.toContain(SECRET);
    expect(legacyWorkflowText).not.toContain("contracts/swap");
    expect(prWorkflowText).not.toContain("DeployMPGRExecutorBaseMainnet.s.sol");
    expect(trustedText).not.toContain("DeployMPGRExecutorBaseMainnet.s.sol");
  });
});

describe("trusted deployment workflow executes only owner-pinned, protected-branch code", () => {
  const jobs = trusted.jobs!;
  const resolve = jobs["resolve-pin"];
  const deploy = jobs["deploy"];

  it("is dispatch-only, guarded to the default branch and an explicit confirmation input", () => {
    const on = (trusted.on ?? (trusted as Record<string, unknown>).true) as Record<string, unknown>;
    expect(Object.keys(on)).toEqual(["workflow_dispatch"]);
    expect(resolve.if).toContain("github.ref == 'refs/heads/main'");
    expect(resolve.if).toContain("DEPLOY_ONE_MPGR_SWAP_EXECUTOR");
  });
  it("resolve-pin runs with no environment and no production secret, and validates the pin", () => {
    expect(resolve.environment).toBeUndefined();
    expect(JSON.stringify(resolve)).not.toContain(SECRET);
    expect(JSON.stringify(resolve)).toContain("vars.SWAP_DEPLOY_REF");
    const run = resolve.steps!.map(s => s.run ?? "").join("\n");
    expect(run).toContain("merge-base --is-ancestor"); // pin must be reviewed code on main
    expect(run).toContain("swapExecutorDeployEnabled"); // gate must be open AT the pin
    expect(run).toContain("mpgr-swap-executor.json"); // duplicate-deployment guard at the pin
  });
  it("deploy job is environment-protected, needs resolve-pin, and checks out the pin", () => {
    const env = typeof deploy.environment === "string" ? deploy.environment : deploy.environment?.name;
    expect(env).toBe("base-mainnet");
    expect(deploy.needs).toBe("resolve-pin");
    expect(String(deploy.steps![0].with?.ref)).toBe("${{ needs.resolve-pin.outputs.sha }}");
  });
  it("verifies HEAD == pin in a secret-free step BEFORE any secret enters scope", () => {
    const steps = deploy.steps!;
    const verifyIdx = steps.findIndex(s => (s.name ?? "").startsWith("Verify checkout equals"));
    expect(verifyIdx).toBe(1);
    expect(JSON.stringify(steps[verifyIdx].env ?? {})).not.toContain(SECRET);
    expect(steps[verifyIdx].run).toContain("git rev-parse HEAD");
    const firstSecretIdx = steps.findIndex(s => JSON.stringify(s.env ?? {}).includes(SECRET));
    expect(firstSecretIdx).toBeGreaterThan(verifyIdx);
    const names = steps.map(s => s.name ?? "");
    const pre = names.findIndex(n => n.startsWith("Preflight"));
    const bc = names.findIndex(n => n.startsWith("Deploy (single broadcast"));
    const seal = names.findIndex(n => n.startsWith("Seal manifest"));
    expect(verifyIdx).toBeLessThan(pre);
    expect(pre).toBeLessThan(bc);
    expect(bc).toBeLessThan(seal);
  });
  it("pins every action to a full immutable SHA in both swap deployment workflows", () => {
    for (const text of [prWorkflowText, trustedText]) {
      const uses = [...text.matchAll(/uses:\s*(\S+)/g)].map(m => m[1]);
      expect(uses.length).toBeGreaterThan(0);
      for (const u of uses) expect(u, `unpinned action ${u}`).toMatch(/@[0-9a-f]{40}$/);
    }
  });
  it("requires a genuine Safe owner verification inside preflight before broadcast", () => {
    expect(preflightSh).toContain("safe-check.sh");
    expect(safeCheckSh).toContain("getThreshold()(uint256)");
    expect(safeCheckSh).toContain("getOwners()(address[])");
    expect(safeCheckSh).toContain("VERSION()(string)");
    // canonical Base Safe singletons (1.3.0, 1.3.0 L2, 1.4.1, 1.4.1 L2, 1.5.0, 1.5.0 L2)
    expect(safeCheckSh).toContain("0xd9db270c1b5e3bd161e8c8503c55ceabee709552");
    expect(safeCheckSh).toContain("0x29fcb43b46531bca003ddc8fcb67ffe91900c762");
    expect(safeCheckSh).toContain("0xedd160febbd92e350d4d398fb636302fccd67c7e");
    // safe-deployments runtime code hash for canonical SafeL2 1.5.0 on Base
    expect(safeCheckSh).toContain("0x180193227186ccb85316c94db1f0d156ed932b14712cfaac78901899178572dc");
    expect(trustedText).toContain("preflight.sh");
  });
});

describe("CODEOWNERS covers every deployment-critical path", () => {
  it("assigns the owner to workflows, pipeline scripts, contracts, manifests and activation config", () => {
    for (const path of [
      "/.github/workflows/",
      "/scripts/swap-deploy/",
      "/contracts/swap/",
      "/script/",
      "/deployments/",
      "/lib/swap/swap-executor-config.ts",
      "/foundry.toml",
    ]) {
      expect(codeowners, path).toContain(path);
    }
    expect(codeowners).toContain("@munazir17");
  });
});

describe("fail-closed execution regressions (offline, no side effects)", () => {
  it("preflight.sh refuses while the committed gate is false, before any RPC use", () => {
    // Unchanged gate-closed code path, exercised against a throwaway worktree so
    // the reviewed, open committed gate is never mutated by the test suite.
    const out = withClosedGateWorktree(dir =>
      runExpectFail(
        "bash",
        ["scripts/swap-deploy/preflight.sh"],
        {
          BASE_MAINNET_RPC_URL: UNREACHABLE_RPC, // never reached: gate check precedes RPC
          BASE_MAINNET_DEPLOYER_PRIVATE_KEY: DUMMY_KEY,
          SWAP_EXECUTOR_OWNER: DUMMY_OWNER,
          MPGR_SWAP_EXECUTOR_DEPLOY_ENABLED: "true",
        },
        dir,
      ),
    );
    expect(out).toContain("committed deployment gate is CLOSED");
    expect(out).not.toContain("invalid.example"); // proves no RPC attempt happened
  });
  it("preflight.sh still refuses WITH the gate open when the run-time approval env is not true", () => {
    // Opening the committed gate authorises an attempt; it does not make a
    // broadcast reachable. The deploy job must still set the explicit env.
    const out = runExpectFail("bash", ["scripts/swap-deploy/preflight.sh"], {
      BASE_MAINNET_RPC_URL: UNREACHABLE_RPC,
      BASE_MAINNET_DEPLOYER_PRIVATE_KEY: DUMMY_KEY,
      SWAP_EXECUTOR_OWNER: DUMMY_OWNER,
      MPGR_SWAP_EXECUTOR_DEPLOY_ENABLED: "false",
    });
    expect(out).toContain("MPGR_SWAP_EXECUTOR_DEPLOY_ENABLED != true");
    expect(out).not.toContain("invalid.example"); // proves no RPC attempt happened
  });
  it("preflight.sh refuses a second deployment now that the sealed manifest is committed", () => {
    // The one authorized deployment already happened: in the committed tree
    // the sealed-record guard is the first manifest refusal reached, before
    // any RPC use, even with the gate open and the run-time approval set.
    const out = runExpectFail("bash", ["scripts/swap-deploy/preflight.sh"], {
      BASE_MAINNET_RPC_URL: UNREACHABLE_RPC,
      BASE_MAINNET_DEPLOYER_PRIVATE_KEY: DUMMY_KEY,
      SWAP_EXECUTOR_OWNER: DUMMY_OWNER,
      MPGR_SWAP_EXECUTOR_DEPLOY_ENABLED: "true",
    });
    expect(out).toContain("final manifest already exists");
    expect(out).not.toContain("invalid.example"); // duplicate guard precedes RPC
  });
  it("preflight.sh still refuses WITH the gate open while an unfinished staging record exists", () => {
    // Pre-deployment guard, unchanged code: reached only in a tree without the
    // sealed manifest, so it is exercised in a throwaway worktree. The stub is
    // written inside the worktree; the committed tree is never touched.
    const out = withNoManifestWorktree(dir => {
      writeFileSync(join(dir, STAGING), JSON.stringify({ executor: "0x1111111111111111111111111111111111111111" }));
      const o = runExpectFail(
        "bash",
        ["scripts/swap-deploy/preflight.sh"],
        {
          BASE_MAINNET_RPC_URL: UNREACHABLE_RPC,
          BASE_MAINNET_DEPLOYER_PRIVATE_KEY: DUMMY_KEY,
          SWAP_EXECUTOR_OWNER: DUMMY_OWNER,
          MPGR_SWAP_EXECUTOR_DEPLOY_ENABLED: "true",
        },
        dir,
      );
      expect(existsSync(join(dir, FINAL))).toBe(false);
      return o;
    });
    expect(out).toContain("staging manifest exists");
    expect(out).not.toContain("invalid.example"); // duplicate guard precedes RPC
  });
  it("preflight.sh refuses when the dedicated deployer secret is missing", () => {
    const out = runExpectFail("bash", ["scripts/swap-deploy/preflight.sh"], {
      BASE_MAINNET_RPC_URL: UNREACHABLE_RPC,
      BASE_MAINNET_DEPLOYER_PRIVATE_KEY: "",
      SWAP_EXECUTOR_OWNER: DUMMY_OWNER,
      MPGR_SWAP_EXECUTOR_DEPLOY_ENABLED: "true",
    });
    expect(out).toContain(SECRET);
  });
  it("safe-check.sh fails closed when the chain cannot be read", () => {
    // The script retries the RPC 5x with backoff (~30s) before failing closed.
    const out = runExpectFail("bash", ["scripts/swap-deploy/safe-check.sh", "0x0000000000000000000000000000000000000001", "https://invalid.example"], {});
    expect(out).toContain("SAFE-CHECK FAIL");
  }, 90_000);
  it("rehearse.sh without the working-tree override fails closed while the committed gate is false", () => {
    // Also keeps this suite anvil-free: the gate check precedes anvil startup,
    // and the closed-gate worktree guarantees we never enter the success path.
    const out = withClosedGateWorktree(dir =>
      runExpectFail("bash", ["scripts/swap-deploy/rehearse.sh", ""], { SWAP_REHEARSAL_OVERRIDE_GATE: "false" }, dir),
    );
    expect(out).toContain("committed deployment gate is CLOSED");
    expect(existsSync(STAGING)).toBe(false);
    // The committed sealed manifest's integrity is asserted by afterEach.
  });
  it("finalize-manifest.sh cannot seal without a staging record", () => {
    const out = runExpectFail("bash", ["scripts/swap-deploy/finalize-manifest.sh", "https://invalid.example"], {});
    expect(out).toContain("staging manifest missing");
  });
  it("finalize-manifest.sh cannot seal without a real broadcast artifact (no broadcast => no manifest)", () => {
    // In the committed tree finalize now refuses even earlier (the sealed
    // manifest exists), so the broadcast-artifact guard is exercised in a
    // throwaway worktree without the final manifest; the stub is written
    // inside the worktree only.
    const out = withNoManifestWorktree(dir => {
      writeFileSync(join(dir, STAGING), JSON.stringify({ executor: "0x1111111111111111111111111111111111111111", deployer: "0x2222222222222222222222222222222222222222" }));
      const o = runExpectFail("bash", ["scripts/swap-deploy/finalize-manifest.sh", "https://invalid.example"], {}, dir);
      expect(existsSync(join(dir, FINAL))).toBe(false);
      return o;
    });
    expect(out).toContain("broadcast artifact missing");
  });
});

describe("solidity preflight enforcement (behavioural tests in test/swap/DeployPreflight.t.sol)", () => {
  it("requires nonce 0, multisig-contract owner and owner != deployer before broadcast", () => {
    expect(deployScript).toContain("require(vm.getNonce(deployer) == 0");
    expect(deployScript).toContain("preflight: owner must be the governance multisig, not the ephemeral deployer");
    expect(deployScript).toContain("preflight: SWAP_EXECUTOR_OWNER must be a deployed multisig contract on Base");
    const broadcastAt = deployScript.indexOf("vm.startBroadcast()");
    const preflightCallAt = deployScript.indexOf("preflightDeployerAndOwner(owner);");
    expect(preflightCallAt).toBeGreaterThan(0);
    expect(broadcastAt).toBeGreaterThan(preflightCallAt);
  });
  it("writes only a staging manifest; the final name is reserved for finalize-manifest.sh", () => {
    expect(deployScript).toContain("vm.writeFile(STAGING_MANIFEST");
    expect(deployScript).not.toContain("vm.writeFile(FINAL_MANIFEST");
  });
});

// ---------------------------------------------------------------------------
// D1 regression: safe-check.sh getOwners() parsing against every layout that
// supported Foundry versions emit (single bracketed line [0x.., 0x..], one
// address per line, bulleted "- 0x.."), using a deterministic fake `cast`.
// Malformed, empty and duplicate output must fail closed; a count is never
// silently derived from data that does not strictly parse.
// ---------------------------------------------------------------------------

const FAKE_SAFE = "0x9999999999999999999999999999999999999999";
const OWNER_A = "0x1111111111111111111111111111111111111111";
const OWNER_B = "0x2222222222222222222222222222222222222222";
const OWNER_C = "0x3333333333333333333333333333333333333333";
const OWNER_MIXED = "0xAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCd";
const SLOT0 = (singleton: string) => `0x000000000000000000000000${singleton.slice(2)}`;
// Canonical Base Mainnet Safe singletons: address, label, runtime code hash
// published by safe-global/safe-deployments. All data is public.
const SINGLETONS: ReadonlyArray<[string, string, string]> = [
  ["0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552", "GnosisSafe 1.3.0", "0xbba688fbdb21ad2bb58bc320638b43d94e7d100f6f3ebaab0a4e4de6304b1c2e"],
  ["0x3E5c63644E683549055b9Be8653de26E0B4CD36E", "GnosisSafeL2 1.3.0", "0x21842597390c4c6e3c1239e434a682b054bd9548eee5e9b1d6a4482731023c0f"],
  ["0x41675C099F32341bf84BFc5382aF534df5C7461a", "Safe 1.4.1", "0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4"],
  ["0x29fcB43b46531BcA003ddC8FCB67FFE91900C762", "SafeL2 1.4.1", "0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff"],
  ["0xFf51A5898e281Db6DfC7855790607438dF2ca44b", "Safe 1.5.0", "0xdda019cbd7c867a533a2a86e5c53434fdc50b13122b5a5ddb4a8df61b31c20f2"],
  ["0xEdd160fEBBD92E350D4D398fb636302fccd67C7e", "SafeL2 1.5.0", "0x180193227186ccb85316c94db1f0d156ed932b14712cfaac78901899178572dc"],
];
const DEFAULT_CODE = "0x6001600155";

function runSafeCheckFake(opts: {
  failAll?: boolean;
  codesize?: string;
  slot0?: string;
  threshold?: string;
  ownersLines?: string[];
  singletonCode?: string;
  singletonCodeHash?: string;
  singletonCodeFails?: boolean;
  env?: Record<string, string>;
}): { ok: boolean; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "safecheck-fake-"));
  try {
    const q = (s: string) => `'${s}'`;
    const owners = (opts.ownersLines ?? [`[${OWNER_A}, ${OWNER_B}, ${OWNER_C}]`]).map(q).join(" ");
    const script = [
      "#!/usr/bin/env bash",
      ...(opts.failAll ? ["exit 1"] : []),
      'case "$*" in',
      `  *codesize*) printf '%s\\n' ${q(opts.codesize ?? "324")}; exit 0 ;;`,
      `  *storage*) printf '%s\\n' ${q(opts.slot0 ?? SLOT0(SINGLETONS[0][0]))}; exit 0 ;;`,
      ...(opts.singletonCodeFails
        ? []
        : [`  *code*) printf '%s\\n' ${q(opts.singletonCode ?? DEFAULT_CODE)}; exit 0 ;;`]),
      `  *keccak*) printf '%s\\n' ${q(opts.singletonCodeHash ?? SINGLETONS[0][2])}; exit 0 ;;`,
      `  *getThreshold*) printf '%s\\n' ${q(opts.threshold ?? "2")}; exit 0 ;;`,
      `  *getOwners*) printf '%s\\n' ${owners}; exit 0 ;;`,
      `  *VERSION*) printf '%s\\n' ${q('"1.3.0"')}; exit 0 ;;`,
      "esac",
      "exit 1",
      "",
    ].join("\n");
    const fake = join(dir, "cast");
    writeFileSync(fake, script);
    chmodSync(fake, 0o755);
    try {
      const out = execFileSync("bash", ["scripts/swap-deploy/safe-check.sh", FAKE_SAFE, "http://fake.rpc"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH ?? ""}`,
          GITHUB_ACTIONS: "",
          // Test seam: scales the retry backoff to zero; the 5-attempt count
          // and every assertion are unchanged from production behaviour.
          SWAP_SAFE_RETRY_BASE_SLEEP: "0",
          ...(opts.env ?? {}),
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
      });
      return { ok: true, out };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("safe-check.sh getOwners() parsing (D1 regression, deterministic fake cast)", () => {
  it("parses the single-line bracketed array modern cast emits ([0x.., 0x..])", () => {
    const r = runSafeCheckFake({ ownersLines: [`[${OWNER_A}, ${OWNER_B}, ${OWNER_C}]`], threshold: "2" });
    expect(r.ok).toBe(true);
    expect(r.out).toContain("SAFE-CHECK PASS");
    expect(r.out).toContain("threshold=2 owners=3");
  });
  it("parses one-address-per-line output", () => {
    const r = runSafeCheckFake({ ownersLines: [OWNER_A, OWNER_B, OWNER_C], threshold: "3" });
    expect(r.ok).toBe(true);
    expect(r.out).toContain("threshold=3 owners=3");
  });
  it("parses bulleted ('- 0x..') multiline output", () => {
    const r = runSafeCheckFake({ ownersLines: [`- ${OWNER_A}`, `- ${OWNER_B}`], threshold: "2" });
    expect(r.ok).toBe(true);
    expect(r.out).toContain("owners=2");
  });
  it("accepts mixed-case addresses (case-insensitive validity, exact count)", () => {
    const r = runSafeCheckFake({ ownersLines: [`[${OWNER_MIXED}, ${OWNER_B}]`], threshold: "2" });
    expect(r.ok).toBe(true);
    expect(r.out).toContain("owners=2");
  });
  it("fails when the threshold exceeds the valid owner count", () => {
    const r = runSafeCheckFake({ ownersLines: [`[${OWNER_A}, ${OWNER_B}]`], threshold: "3" });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("fewer than threshold");
  });
  it("fails closed on an empty owner array", () => {
    const r = runSafeCheckFake({ ownersLines: ["[]"], threshold: "1" });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("empty owner list");
  });
  it("fails closed on malformed entries instead of silently counting", () => {
    const bad: string[][] = [
      [`[0x123, ${OWNER_B}]`],        // far too short
      [`0x${"4".repeat(41)}`],        // 41 hex chars: not 20 bytes
      [`0x${"5".repeat(64)}`],        // 32-byte word: never counted as an address
      ["[not-an-address]"],           // garbage token
    ];
    for (const lines of bad) {
      const r = runSafeCheckFake({ ownersLines: lines, threshold: "1" });
      expect(r.ok, `expected failure for ${lines[0].slice(0, 24)}...`).toBe(false);
      expect(r.out).toContain("not a 20-byte address");
    }
  });
  it("fails closed on duplicate owners (case-insensitive)", () => {
    const r = runSafeCheckFake({ ownersLines: [`[${OWNER_MIXED}, ${OWNER_MIXED.toLowerCase()}]`], threshold: "1" });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("duplicate owner");
  });
  it("fails closed for a codeless (non-Safe) address", () => {
    const r = runSafeCheckFake({ codesize: "0" });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("no bytecode");
  });
  it("fails closed on an unrecognised slot-0 singleton", () => {
    const r = runSafeCheckFake({ slot0: SLOT0("0x00000000000000000000000000000000DeAdBeEf") });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("NOT a recognised Safe proxy");
  });
  it("recognises every canonical Base Safe singleton by address AND runtime code hash", () => {
    for (const [singleton, impl, codeHash] of SINGLETONS) {
      const r = runSafeCheckFake({ slot0: SLOT0(singleton), singletonCodeHash: codeHash });
      expect(r.ok, `expected pass for ${impl}`).toBe(true);
      expect(r.out).toContain(`genuine ${impl}`);
      expect(r.out).toContain(`singleton_codehash=${codeHash}`);
    }
  });
  it("accepts the reported SafeL2 1.5.0 singleton (Base canonical deployment)", () => {
    const [, impl, codeHash] = SINGLETONS[5];
    const r = runSafeCheckFake({ slot0: SLOT0(SINGLETONS[5][0]), singletonCodeHash: codeHash, threshold: "2" });
    expect(r.ok).toBe(true);
    expect(r.out).toContain(`genuine ${impl}`);
    expect(r.out).toContain("threshold=2");
  });
  it("rejects a canonical singleton address whose runtime code hash differs (impersonating bytecode)", () => {
    // Slot 0 names SafeL2 1.5.0, but the code at that address is arbitrary:
    // this is exactly the case address-only allowlisting would let through.
    const r = runSafeCheckFake({
      slot0: SLOT0("0xEdd160fEBBD92E350D4D398fb636302fccd67C7e"),
      singletonCode: "0xdeadbeef",
      singletonCodeHash: `0x${"de".repeat(32)}`,
    });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("pinned implementation (SafeL2 1.5.0)");
    expect(r.out).toContain("runtime code hash");
  });
  it("fails closed when the singleton bytecode cannot be read", () => {
    const r = runSafeCheckFake({ singletonCodeFails: true });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("cannot read singleton");
  });
  it("requires an explicit code hash for owner-allowlisted extra singletons", () => {
    const extra = "0x00000000000000000000000000000000DeAdBeEf";
    const hash = `0x${"ab".repeat(32)}`;
    const withHash = runSafeCheckFake({
      slot0: SLOT0(extra),
      singletonCodeHash: hash,
      env: { SWAP_SAFE_EXTRA_SINGLETONS: `${extra}:${hash}` },
    });
    expect(withHash.ok).toBe(true);
    expect(withHash.out).toContain("owner-allowlisted singleton");
    // An override naming a known address cannot bypass the bytecode pin: the
    // on-chain code hash must still equal the supplied canonical hash.
    const wrongHash = runSafeCheckFake({
      slot0: SLOT0(extra),
      singletonCode: "0xdeadbeef",
      singletonCodeHash: `0x${"cd".repeat(32)}`,
      env: { SWAP_SAFE_EXTRA_SINGLETONS: `${extra}:${hash}` },
    });
    expect(wrongHash.ok).toBe(false);
    expect(wrongHash.out).toContain("runtime code hash");
    const shortHash = runSafeCheckFake({
      slot0: SLOT0(extra),
      env: { SWAP_SAFE_EXTRA_SINGLETONS: `${extra}:0xabcd` },
    });
    expect(shortHash.ok).toBe(false);
    expect(shortHash.out).toContain("invalid expected runtime code hash");
    const withoutHash = runSafeCheckFake({ slot0: SLOT0(extra), env: { SWAP_SAFE_EXTRA_SINGLETONS: extra } });
    expect(withoutHash.ok).toBe(false);
    expect(withoutHash.out).toContain("must be address:codehash");
  });
  it("enforces SWAP_SAFE_MIN_THRESHOLD without weakening the owners check", () => {
    const r = runSafeCheckFake({ threshold: "2", env: { SWAP_SAFE_MIN_THRESHOLD: "3" } });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("below required minimum");
  });
  it("fails closed when every RPC call fails", () => {
    const r = runSafeCheckFake({ failAll: true });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("RPC unavailable");
  });
});
