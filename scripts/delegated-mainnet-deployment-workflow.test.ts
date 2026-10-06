import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EXPECTED_DEPLOYER,
  EXPECTED_EXECUTOR,
  EXPECTED_FEE_RECIPIENT,
  EXPECTED_OWNER,
  EXPECTED_TOKENS,
  EXPECTED_ROUTERS,
  EXPECTED_SEPOLIA_DENYLIST,
  predictedExecutorAddress,
  validateDeploymentConfig,
} from "./delegated-mainnet-deployment-guard.mjs";

const config = JSON.parse(readFileSync("deployments/base-mainnet/delegated-deploy-config.json", "utf8"));
const workflow = readFileSync(".github/workflows/deploy-delegated-base-mainnet.yml", "utf8");
const deploymentGuard = readFileSync("scripts/delegated-mainnet-deployment-guard.mjs", "utf8");
const deploymentScript = readFileSync("script/DeployMPGRExecutorDelegatedBaseMainnet.s.sol", "utf8");
const foundryConfig = readFileSync("foundry.toml", "utf8");
const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as { load: (text: string) => unknown };
const validateDeploymentConfigWithOptions = validateDeploymentConfig as (
  config: unknown,
  options: { owner?: string; feeRecipient?: string; deployEnabled?: string; artifactExists?: boolean },
) => { ok: boolean; checks: Array<{ ok: boolean; name: string }> };

function textBetween(source: string, start: string, end?: string): string {
  const startIndex = source.indexOf(start);
  if (startIndex < 0) return "";
  const endIndex = end ? source.indexOf(end, startIndex + start.length) : source.length;
  return endIndex < 0 ? "" : source.slice(startIndex, endIndex);
}

describe("protected delegated Base Mainnet deployment workflow", () => {
  it("is valid YAML and can only be manually dispatched with an explicit confirmation", () => {
    expect(() => yaml.load(workflow)).not.toThrow();
    const header = textBetween(workflow, "\non:\n", "\npermissions:");
    expect(header).toContain("workflow_dispatch:");
    expect(header).not.toContain("push:");
    expect(header).not.toContain("pull_request:");
    expect(workflow).toContain("DEPLOY_ONE_MPGR_EXECUTOR_DELEGATED");
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain("github.run_attempt == 1");
  });

  it("pins the CI-validated released toolchain exactly", () => {
    expect(workflow).toContain("version: v1.8.4");
    expect(workflow).toContain("50af4efe189dc64bad2b75ed6990b835de66c4ae");
    expect(workflow).toContain("Version: 0.8.24+commit.e11b9ed9");
    expect(foundryConfig).toContain('solc_version = "0.8.24"');
  });

  it("targets only MPGRExecutorDelegated and requires the protected Environment for both jobs", () => {
    const preflightJob = textBetween(workflow, "  read-only-preflight:", "  deploy:");
    const deployJob = textBetween(workflow, "  deploy:");
    expect(preflightJob).toContain("environment: base-mainnet");
    expect(deployJob).toContain("environment: base-mainnet");
    expect(deployJob).toContain("needs: read-only-preflight");
    expect(workflow).toContain("script/DeployMPGRExecutorDelegatedBaseMainnet.s.sol");
    expect(workflow).toContain("script/RecordMPGRExecutorDelegatedBaseMainnet.s.sol");
    expect(workflow).not.toContain("script/DeployMPGRExecutorBaseMainnet.s.sol");
    expect(workflow).not.toContain("script/DeployMPGRExecutorBaseSepolia.s.sol");
    expect(workflow).not.toContain("DeployMPGRExecutorDelegatedBaseSepolia.s.sol");
    expect(preflightJob).not.toContain("BASE_MAINNET_DEPLOYER_PRIVATE_KEY");
    expect(deployJob).toContain("BASE_MAINNET_DEPLOYER_PRIVATE_KEY: ${{ secrets.BASE_MAINNET_DEPLOYER_PRIVATE_KEY }}");
    expect(deployJob).toContain("BASE_MAINNET_RPC_URL: ${{ secrets.BASE_MAINNET_RPC_URL }}");
    expect(deployJob).toContain("MPGR_EXECUTOR_OWNER: ${{ vars.MPGR_EXECUTOR_OWNER }}");
    expect(deployJob).toContain("MPGR_EXECUTOR_FEE_RECIPIENT: ${{ vars.MPGR_EXECUTOR_FEE_RECIPIENT }}");
    expect(deployJob).toContain("MPGR_MAINNET_DELEGATED_DEPLOY_ENABLED: ${{ vars.MPGR_MAINNET_DELEGATED_DEPLOY_ENABLED }}");
  });

  it("keeps read-only preflight separate and puts the exact-address guard immediately before one broadcast", () => {
    const preflightJob = textBetween(workflow, "  read-only-preflight:", "  deploy:");
    const deployJob = textBetween(workflow, "  deploy:");
    const guardStep = deployJob.indexOf("- name: Mandatory immediate pre-broadcast verification");
    const broadcastStep = deployJob.indexOf("\n      - name: Broadcast exactly one MPGRExecutorDelegated CREATE transaction");
    const nextStepAfterGuard = deployJob.indexOf("\n      - name:", guardStep + 1);

    expect(preflightJob).toContain("delegated-mainnet-deployment-guard.mjs --phase=preflight");
    expect(preflightJob).not.toContain("--broadcast");
    expect(preflightJob).not.toContain("BASE_MAINNET_DEPLOYER_PRIVATE_KEY");
    expect(deployJob).toContain("forge script script/DeployMPGRExecutorDelegatedBaseMainnet.s.sol --rpc-url");
    expect(deployJob).toContain("--sig 'run()' -vv");
    expect(deployJob).toContain("--phase=prebroadcast");
    expect(guardStep).toBeGreaterThanOrEqual(0);
    expect(nextStepAfterGuard).toBe(broadcastStep);
    expect((workflow.match(/--broadcast/g) ?? [])).toHaveLength(1);
    expect(deployJob).toContain("timeout --signal=TERM --kill-after=30s 40m forge script");
    expect(deployJob).toContain("no retry will be attempted");
    expect((deploymentScript.match(/_startBroadcast\(c\.pk\)/g) ?? [])).toHaveLength(1);
    expect((deploymentScript.match(/new MPGRExecutorDelegated\(/g) ?? [])).toHaveLength(1);
    expect(deployJob).toContain("--phase=reconcile");
    expect(deployJob).toContain("Confirm the single deployment receipt (read-only)");
    expect(deployJob).toContain("steps.receipt_confirmation.outcome == 'failure'");
    expect(deployJob).toContain("steps.reconcile.outputs.receipt_confirmed == 'true'");
    expect(workflow).toContain("cancel-in-progress: false");
  });

  it("preserves both production gates and requires the reviewed config arm", () => {
    expect(config.mainnetDelegatedDeployEnabled).toBe(true);
    expect(workflow).toContain("flag remains the second independent");
    expect(deploymentGuard).toContain('add(config.mainnetDelegatedDeployEnabled === true, "config_deploy_flag"');
    expect(deploymentGuard).toContain('add(deployEnabled === "true", "environment_deploy_flag"');
    expect(deploymentScript).toContain("c.envEnabled, \"MPGR: MPGR_MAINNET_DELEGATED_DEPLOY_ENABLED != true");
    expect(deploymentScript).toContain("require(p.enabled,");
    expect(deploymentScript).toContain("MPGR: MPGR_MAINNET_DELEGATED_DEPLOY_ENABLED != true");
    expect(deploymentScript).toContain("delegated-deploy-config.json mainnetDelegatedDeployEnabled != true");
  });

  it("pins the deployer and refuses any CREATE address other than the audited target", () => {
    expect(EXPECTED_DEPLOYER).toBe("0x954BFdf0b3A262D537c825a40F7ba960830be88A");
    expect(EXPECTED_EXECUTOR).toBe("0x39B1C6Ea88A01e70cbF4899BF3cEfB2c43cD32Bb");
    expect(predictedExecutorAddress(EXPECTED_DEPLOYER, 0n).toLowerCase()).toBe(EXPECTED_EXECUTOR.toLowerCase());
    expect(deploymentGuard).toContain('check(sameAddress(predicted, EXPECTED_EXECUTOR), "predicted_create_address"');
    expect(deploymentGuard).toContain('check(sameAddress(deployerAddress, EXPECTED_DEPLOYER), "dedicated_deployer_pin"');
    expect(deploymentGuard).toContain('check(code === undefined || code === "0x", "predicted_executor_empty_code"');
    expect(deploymentGuard).toContain('check(latestNonce === 0, "deployer_latest_nonce_zero"');
    expect(deploymentGuard).toContain('check(pendingNonce === 0, "deployer_pending_nonce_zero"');
    expect(deploymentGuard).toContain("privateKeyToAccount(privateKey).address");
    expect(deploymentGuard).not.toContain("console.log(privateKey");
  });

  it("requires the exact deployed token/router/denylist pins and emits read-only post-deploy verification", () => {
    expect(EXPECTED_TOKENS).toHaveLength(50);
    expect(EXPECTED_ROUTERS).toHaveLength(2);
    expect(EXPECTED_SEPOLIA_DENYLIST).toHaveLength(9);
    expect(EXPECTED_ROUTERS[0].kindName).toBe("AERODROME_SLIPSTREAM");
    expect(EXPECTED_ROUTERS[1].kindName).toBe("UNISWAP_V3_ROUTER02");
    expect(EXPECTED_ROUTERS[1].factory).toBe("0x33128a8fC17869897dcE68Ed026d694621f6FDfD");
    expect(EXPECTED_ROUTERS[1].quoterV2).toBe("0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a");
    expect(EXPECTED_ROUTERS[1].usdcWethPool).toBe("0x6c561B446416E1A00E8E93E221854d6eA4171372");
    expect(EXPECTED_ROUTERS[1].usdcWethPoolFee).toBe(3000);
    expect(workflow).toContain("cast receipt");
    expect(workflow).toContain("Runtime bytecode: present");
    expect(workflow).toContain("fee recipient:");
    expect(workflow).toContain("WETH:");
    expect(workflow).toContain("Permit2:");
    expect(workflow).toContain("paused: false");
    expect(workflow).toContain("Verified token allowlist (50)");
    expect(workflow).toContain("Verified router configurations (2)");
    expect(workflow).toContain("exactly one delegated CREATE transaction");
    expect(workflow).toContain("RecordMPGRExecutorDelegatedBaseMainnet.s.sol");
    expect(workflow).toContain("Swaps, canary trades, approvals, and autonomous actions: none");
  });

  it("accepts the reviewed config arm while preserving the environment gate", () => {
    const common = {
      owner: EXPECTED_OWNER,
      feeRecipient: EXPECTED_FEE_RECIPIENT,
      deployEnabled: "true",
      artifactExists: false,
    };
    const current = validateDeploymentConfigWithOptions(config, common);
    expect(current.ok).toBe(true);
    expect(current.checks.find((item) => item.name === "config_deploy_flag")?.ok).toBe(true);

    const enabledForReviewedDeployment = { ...config, mainnetDelegatedDeployEnabled: true };
    const prospective = validateDeploymentConfigWithOptions(enabledForReviewedDeployment, common);
    expect(prospective.ok).toBe(true);

    const disabledEnvironment = validateDeploymentConfigWithOptions(enabledForReviewedDeployment, {
      ...common,
      deployEnabled: "false",
    });
    expect(disabledEnvironment.ok).toBe(false);
    expect(disabledEnvironment.checks.find((item) => item.name === "environment_deploy_flag")?.ok).toBe(false);
  });
});
