import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

// Regression suite for the DEDICATED swap-executor deployment path
// (.github/workflows/deploy-swap-executor-base-mainnet.yml + scripts/swap-deploy/*).
// Proves fail-closed behaviour OFFLINE: with either deployment gate false, no
// broadcast and no manifest finalization can occur, and no side-effect files
// are left behind. Runs without network, without anvil, and without secrets.

const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as { load: (text: string) => unknown };

const deployWorkflowText = readFileSync(".github/workflows/deploy-swap-executor-base-mainnet.yml", "utf8");
const forkWorkflowText = readFileSync(".github/workflows/swap-fork-tests-base-mainnet.yml", "utf8");
const legacyWorkflowText = readFileSync(".github/workflows/deploy-executor-base-mainnet.yml", "utf8");
const deployConfig = JSON.parse(readFileSync("deployments/base-mainnet/deploy-config.json", "utf8"));
const libConfigText = readFileSync("lib/swap/swap-executor-config.ts", "utf8");
const preflightSh = readFileSync("scripts/swap-deploy/preflight.sh", "utf8");
const rehearseSh = readFileSync("scripts/swap-deploy/rehearse.sh", "utf8");
const deployScript = readFileSync("script/DeployMPGRSwapExecutorBaseMainnet.s.sol", "utf8");

type Job = { name?: string; needs?: string | string[]; environment?: string | { name: string }; steps?: Array<{ name?: string; run?: string; env?: Record<string, string> }> };
type Workflow = { on?: unknown; jobs?: Record<string, Job> };
const deployWorkflow = yaml.load(deployWorkflowText) as Workflow;

const STAGING = "deployments/base-mainnet/mpgr-swap-executor.staging.json";
const FINAL = "deployments/base-mainnet/mpgr-swap-executor.json";

function runExpectFail(cmd: string, args: string[], env: Record<string, string>): string {
  try {
    const out = execFileSync(cmd, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    throw new Error(`expected failure but command succeeded: ${out.slice(0, 200)}`);
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    if (err.message?.startsWith("expected failure but command succeeded")) throw e;
    return `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
}

afterEach(() => {
  // No test may ever leave deployment side effects behind.
  expect(existsSync(FINAL), "final manifest must never exist during tests").toBe(false);
  if (existsSync(STAGING)) rmSync(STAGING);
});

describe("committed production gates stay closed", () => {
  it("pins swapExecutorDeployEnabled=false and mainnetDeployEnabled=false", () => {
    expect(deployConfig.chainId).toBe(8453);
    expect(deployConfig.swapExecutorDeployEnabled).toBe(false);
    expect(deployConfig.mainnetDeployEnabled).toBe(false);
  });
  it("keeps swap routing deactivated in app config and has no manifest on disk", () => {
    expect(libConfigText).toContain("export const SWAP_PATH_EXECUTOR_DEPLOYMENT: SwapPathExecutorDeployment | null = null;");
    expect(existsSync(FINAL)).toBe(false);
    expect(existsSync(STAGING)).toBe(false);
  });
  it("cannot emit the old 'pending-record' placeholder and actively guards against it", () => {
    // The deploy script (which WRITES the staging manifest) must not contain the
    // placeholder at all; the sealing/verification layers must carry the guard.
    expect(deployScript).not.toContain("pending-record");
    expect(preflightSh).not.toContain("pending-record");
    const finalizeSh = readFileSync("scripts/swap-deploy/finalize-manifest.sh", "utf8");
    expect(finalizeSh).toContain("grep -q 'pending-record'");
    expect(rehearseSh).toContain("grep -q 'pending-record'");
    expect(deployWorkflowText).toContain("grep -q 'pending-record'");
  });
});

describe("deployment workflow structure", () => {
  it("triggers only on the dedicated label from the same repository", () => {
    const on = deployWorkflow.on as Record<string, unknown>;
    expect(Object.keys(on)).toEqual(["pull_request"]);
    expect(deployWorkflowText).toContain("deploy-swap-base-mainnet");
    expect(deployWorkflowText).toContain("head.repo.full_name == github.repository");
  });
  it("gives the protected environment ONLY to the deploy job and production secrets to no other job", () => {
    const jobs = deployWorkflow.jobs!;
    expect(jobs.deploy.needs).toBe("gates");
    expect(typeof jobs.deploy.environment === "string" ? jobs.deploy.environment : jobs.deploy.environment?.name).toBe("base-mainnet");
    expect(jobs.gates.environment).toBeUndefined();
    const gatesText = JSON.stringify(jobs.gates);
    expect(gatesText).not.toContain("SWAP_BASE_MAINNET_DEPLOYER_PRIVATE_KEY");
    // The dedicated secret name appears in exactly one workflow file overall.
    expect(deployWorkflowText).toContain("SWAP_BASE_MAINNET_DEPLOYER_PRIVATE_KEY");
    expect(forkWorkflowText).not.toContain("SWAP_BASE_MAINNET_DEPLOYER_PRIVATE_KEY");
    expect(legacyWorkflowText).not.toContain("SWAP_BASE_MAINNET_DEPLOYER_PRIVATE_KEY");
    expect(legacyWorkflowText).not.toContain("contracts/swap");
    expect(deployWorkflowText).not.toContain("DeployMPGRExecutorBaseMainnet.s.sol");
  });
  it("runs preflight strictly before the broadcast step, and finalize before any manifest claim", () => {
    const steps = deployWorkflow.jobs!.deploy.steps!;
    const names = steps.map(s => s.name ?? "");
    const pre = names.findIndex(n => n.startsWith("Preflight"));
    const bc = names.findIndex(n => n.startsWith("Deploy (single broadcast"));
    const seal = names.findIndex(n => n.startsWith("Seal manifest"));
    expect(pre).toBeGreaterThanOrEqual(0);
    expect(bc).toBeGreaterThan(pre);
    expect(seal).toBeGreaterThan(bc);
  });
  it("keeps the fork-tests workflow read-only (no broadcast, no deploy secrets)", () => {
    expect(forkWorkflowText).not.toContain("--broadcast");
    expect(forkWorkflowText).not.toContain("PRIVATE_KEY");
  });
});

describe("fail-closed execution regressions (offline, no side effects)", () => {
  it("preflight.sh refuses while the committed gate is false, before any RPC use", () => {
    const out = runExpectFail("bash", ["scripts/swap-deploy/preflight.sh"], {
      BASE_MAINNET_RPC_URL: "https://invalid.example", // never reached: gate check precedes RPC
      BASE_MAINNET_DEPLOYER_PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
      SWAP_EXECUTOR_OWNER: "0x0000000000000000000000000000000000000001",
      MPGR_SWAP_EXECUTOR_DEPLOY_ENABLED: "true",
    });
    expect(out).toContain("committed deployment gate is CLOSED");
    expect(out).not.toContain("invalid.example"); // proves no RPC attempt happened
  });
  it("preflight.sh refuses when the dedicated deployer secret is missing", () => {
    const out = runExpectFail("bash", ["scripts/swap-deploy/preflight.sh"], {
      BASE_MAINNET_RPC_URL: "https://invalid.example",
      BASE_MAINNET_DEPLOYER_PRIVATE_KEY: "",
      SWAP_EXECUTOR_OWNER: "0x0000000000000000000000000000000000000001",
      MPGR_SWAP_EXECUTOR_DEPLOY_ENABLED: "true",
    });
    expect(out).toContain("SWAP_BASE_MAINNET_DEPLOYER_PRIVATE_KEY");
  });
  it("rehearse.sh without the working-tree override fails closed while the committed gate is false", () => {
    const out = runExpectFail("bash", ["scripts/swap-deploy/rehearse.sh", ""], {
      SWAP_REHEARSAL_OVERRIDE_GATE: "false",
    });
    expect(out).toContain("committed deployment gate is CLOSED");
    expect(existsSync(STAGING)).toBe(false);
    expect(existsSync(FINAL)).toBe(false);
  });
  it("finalize-manifest.sh cannot seal without a staging record", () => {
    const out = runExpectFail("bash", ["scripts/swap-deploy/finalize-manifest.sh", "https://invalid.example"], {});
    expect(out).toContain("staging manifest missing");
  });
  it("finalize-manifest.sh cannot seal without a real broadcast artifact (no broadcast => no manifest)", () => {
    writeFileSync(STAGING, JSON.stringify({ executor: "0x1111111111111111111111111111111111111111", deployer: "0x2222222222222222222222222222222222222222" }));
    try {
      const out = runExpectFail("bash", ["scripts/swap-deploy/finalize-manifest.sh", "https://invalid.example"], {});
      expect(out).toContain("broadcast artifact missing");
      expect(existsSync(FINAL)).toBe(false);
    } finally {
      rmSync(STAGING, { force: true });
    }
  });
});

describe("solidity preflight enforcement (source-level pins; behavioural tests in test/swap/DeployPreflight.t.sol)", () => {
  it("requires nonce 0, multisig-contract owner and owner != deployer before broadcast", () => {
    expect(deployScript).toContain('require(vm.getNonce(deployer) == 0');
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
