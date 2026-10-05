import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  decodeDeploymentFlagSource,
  isReadOnlyDeploymentFlagFalse,
  readOnlyDeploymentFlagStatus,
  runReadOnlyChecksWhenDeploymentIsDisabled,
  validateStaticConfig,
} from "./delegated-mainnet-preflight.mjs";

const committedConfig = JSON.parse(
  readFileSync("deployments/base-mainnet/delegated-deploy-config.json", "utf8"),
);
const preflightWorkflow = readFileSync(".github/workflows/preflight-delegated-base-mainnet.yml", "utf8");
const preflightChecker = readFileSync("scripts/delegated-mainnet-preflight.mjs", "utf8");

function validate(
  config = committedConfig,
  overrides: {
    owner?: string;
    feeRecipient?: string;
    deployFlag?: string | boolean | Array<string | boolean | null | undefined>;
  } = {},
) {
  const hasOverride = (key: keyof typeof overrides) => Object.prototype.hasOwnProperty.call(overrides, key);
  const owner = hasOverride("owner") ? overrides.owner : committedConfig.owner;
  const feeRecipient = hasOverride("feeRecipient") ? overrides.feeRecipient : committedConfig.feeRecipient;
  const deployFlag = hasOverride("deployFlag") ? overrides.deployFlag : "false";
  return validateStaticConfig(config, owner, feeRecipient, deployFlag);
}

function createReadOnlyStages(steps: string[]) {
  const deployerAddress = "0x000000000000000000000000000000000000bEEF";
  return {
    deriveDeployerAddress: vi.fn(async () => {
      steps.push("derive_deployer_address");
      return deployerAddress;
    }),
    checkRoleSeparation: vi.fn(async (address: string) => {
      steps.push(`check_roles:${address}`);
      return true;
    }),
    runRpcChecks: vi.fn(async (address: string) => {
      steps.push(`rpc_checks:${address}`);
    }),
  };
}

describe("read-only delegated Base Mainnet preflight state machine", () => {
  it("treats both committed and environment false flags as PASS", () => {
    const result = validate();

    expect(result.ok).toBe(true);
    expect(result.checks.find(({ name }) => name === "config_deploy_flag")?.ok).toBe(true);
    expect(result.checks.find(({ name }) => name === "environment_deploy_flag")?.ok).toBe(true);
    expect(validate(committedConfig, { deployFlag: false }).ok).toBe(true);
    expect(isReadOnlyDeploymentFlagFalse(false)).toBe(true);
    expect(readOnlyDeploymentFlagStatus(["false", undefined])).toMatchObject({
      ok: true,
      configuredSources: 1,
      detail: "false; deployment remains disabled",
    });
    expect(isReadOnlyDeploymentFlagFalse(["false", undefined])).toBe(true);
    expect(isReadOnlyDeploymentFlagFalse(["false", ""])).toBe(true);
    expect(isReadOnlyDeploymentFlagFalse(["false", "true"])).toBe(false);
    expect(isReadOnlyDeploymentFlagFalse(true)).toBe(false);
  });

  it("passes the Environment variable false through the actual workflow-to-checker boundary", async () => {
    expect(preflightWorkflow).toContain("environment: base-mainnet");
    expect(preflightWorkflow).toContain(
      "MPGR_MAINNET_DELEGATED_DEPLOY_ENABLED: ${{ vars.MPGR_MAINNET_DELEGATED_DEPLOY_ENABLED }}",
    );
    expect(preflightWorkflow).toContain(
      "MPGR_MAINNET_DELEGATED_DEPLOY_ENABLED_SECRET: ${{ secrets.MPGR_MAINNET_DELEGATED_DEPLOY_ENABLED }}",
    );
    expect(preflightWorkflow).not.toContain("vars.MPGR_MAINNET_DELEGATED_DEPLOY_ENABLED ||");
    expect(preflightChecker).toContain(
      "decodeDeploymentFlagSource(process.env.MPGR_MAINNET_DELEGATED_DEPLOY_ENABLED)",
    );
    expect(preflightChecker).toContain(
      "decodeDeploymentFlagSource(process.env.MPGR_MAINNET_DELEGATED_DEPLOY_ENABLED_SECRET)",
    );

    const workflowValue = decodeDeploymentFlagSource("false");
    const booleanValue = decodeDeploymentFlagSource(JSON.stringify(false));
    expect(workflowValue).toBe("false");
    expect(typeof workflowValue).toBe("string");
    expect(booleanValue).toBe("false");

    const staticResult = validateStaticConfig(
      committedConfig,
      committedConfig.owner,
      committedConfig.feeRecipient,
      [workflowValue, undefined],
    );
    expect(staticResult.ok).toBe(true);
    expect(staticResult.checks.find(({ name }) => name === "environment_deploy_flag")).toMatchObject({
      ok: true,
      detail: "false; deployment remains disabled",
    });

    const stages = createReadOnlyStages([]);
    const continuation = await runReadOnlyChecksWhenDeploymentIsDisabled([workflowValue, undefined], stages);
    expect(continuation).toEqual({ ok: true, continued: true, stage: "rpc" });
    expect(stages.deriveDeployerAddress).toHaveBeenCalledTimes(1);
    expect(stages.checkRoleSeparation).toHaveBeenCalledTimes(1);
    expect(stages.runRpcChecks).toHaveBeenCalledTimes(1);
  });

  it("continues through deployer, role, and RPC stages when the deployment flag is false", async () => {
    const steps: string[] = [];
    const stages = createReadOnlyStages(steps);

    const result = await runReadOnlyChecksWhenDeploymentIsDisabled(["false", undefined], stages);

    expect(result).toEqual({ ok: true, continued: true, stage: "rpc" });
    expect(stages.deriveDeployerAddress).toHaveBeenCalledTimes(1);
    expect(stages.checkRoleSeparation).toHaveBeenCalledTimes(1);
    expect(stages.runRpcChecks).toHaveBeenCalledTimes(1);
    expect(steps).toEqual([
      "derive_deployer_address",
      "check_roles:0x000000000000000000000000000000000000bEEF",
      "rpc_checks:0x000000000000000000000000000000000000bEEF",
    ]);
  });

  it("does not require the deployment flag to be true for read-only checks", async () => {
    const stages = createReadOnlyStages([]);

    const result = await runReadOnlyChecksWhenDeploymentIsDisabled(false, stages);

    expect(result.ok).toBe(true);
    expect(stages.deriveDeployerAddress).toHaveBeenCalledTimes(1);
    expect(stages.runRpcChecks).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "", "true", "False", "0", ["false", "true"]])(
    "fails closed without continuing when the deployment flag is missing, invalid, or conflicting (%s)",
    async (flag) => {
      const stages = createReadOnlyStages([]);
      const result = await runReadOnlyChecksWhenDeploymentIsDisabled(flag, stages);

      expect(result).toEqual({ ok: false, continued: false, stage: "deployment-flag" });
      expect(stages.deriveDeployerAddress).not.toHaveBeenCalled();
      expect(stages.checkRoleSeparation).not.toHaveBeenCalled();
      expect(stages.runRpcChecks).not.toHaveBeenCalled();
    },
  );

  it("fails static validation for missing or invalid required configuration", () => {
    expect(validate(null).ok).toBe(false);
    expect(validate({ ...committedConfig, chainId: 84532 }).ok).toBe(false);
    expect(validate({ ...committedConfig, owner: "not-an-address" }).ok).toBe(false);
    expect(validate({ ...committedConfig, feeRecipient: undefined }).ok).toBe(false);
    expect(validate(committedConfig, { owner: undefined }).ok).toBe(false);
    expect(validate(committedConfig, { owner: "not-an-address" }).ok).toBe(false);
    expect(validate(committedConfig, { feeRecipient: undefined }).ok).toBe(false);
    expect(validate(committedConfig, { feeRecipient: "not-an-address" }).ok).toBe(false);
    expect(validate(committedConfig, { feeRecipient: "0x0000000000000000000000000000000000000001" }).ok).toBe(false);
    expect(validate(committedConfig, { deployFlag: undefined }).ok).toBe(false);
    expect(validate(committedConfig, { deployFlag: "true" }).ok).toBe(false);
  });
});
