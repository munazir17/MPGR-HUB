import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  runReadOnlyChecksWhenDeploymentIsDisabled,
  validateStaticConfig,
} from "./delegated-mainnet-preflight.mjs";

const committedConfig = JSON.parse(
  readFileSync("deployments/base-mainnet/delegated-deploy-config.json", "utf8"),
);

function validate(
  config = committedConfig,
  overrides: { owner?: string; feeRecipient?: string; deployFlag?: string } = {},
) {
  const hasOverride = (key: keyof typeof overrides) => Object.prototype.hasOwnProperty.call(overrides, key);
  const owner = hasOverride("owner") ? overrides.owner : committedConfig.owner;
  const feeRecipient = hasOverride("feeRecipient") ? overrides.feeRecipient : committedConfig.feeRecipient;
  const deployFlag = hasOverride("deployFlag") ? overrides.deployFlag : "false";
  return validateStaticConfig(config, owner, feeRecipient, deployFlag);
}

describe("read-only delegated Base Mainnet preflight state machine", () => {
  it("treats both committed and environment false flags as PASS", () => {
    const result = validate();

    expect(result.ok).toBe(true);
    expect(result.checks.find(({ name }) => name === "config_deploy_flag")?.ok).toBe(true);
    expect(result.checks.find(({ name }) => name === "environment_deploy_flag")?.ok).toBe(true);
  });

  it("continues into deployer derivation and RPC checks when the deployment flag is false", async () => {
    const steps: string[] = [];
    const continueReadOnlyChecks = vi.fn(async () => {
      steps.push("derive_deployer_address");
      steps.push("rpc_chain_nonce_balance_and_contract_reads");
    });

    const result = await runReadOnlyChecksWhenDeploymentIsDisabled("false", continueReadOnlyChecks);

    expect(result).toEqual({ ok: true, continued: true });
    expect(continueReadOnlyChecks).toHaveBeenCalledTimes(1);
    expect(steps).toEqual([
      "derive_deployer_address",
      "rpc_chain_nonce_balance_and_contract_reads",
    ]);
  });

  it("does not require the deployment flag to be true for read-only checks", async () => {
    const continueReadOnlyChecks = vi.fn();

    const result = await runReadOnlyChecksWhenDeploymentIsDisabled("false", continueReadOnlyChecks);

    expect(result.ok).toBe(true);
    expect(continueReadOnlyChecks).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "", "true", "False", "0"]) (
    "fails closed without continuing when the deployment flag is missing or not exactly false (%s)",
    async (flag) => {
      const continueReadOnlyChecks = vi.fn();
      const result = await runReadOnlyChecksWhenDeploymentIsDisabled(flag, continueReadOnlyChecks);

      expect(result).toEqual({ ok: false, continued: false });
      expect(continueReadOnlyChecks).not.toHaveBeenCalled();
    },
  );

  it("fails static validation for missing or invalid required configuration", () => {
    expect(validate(null).ok).toBe(false);
    expect(validate({ ...committedConfig, chainId: 84532 }).ok).toBe(false);
    expect(validate({ ...committedConfig, owner: "not-an-address" }).ok).toBe(false);
    expect(validate(committedConfig, { owner: undefined }).ok).toBe(false);
    expect(validate(committedConfig, { feeRecipient: "0x0000000000000000000000000000000000000001" }).ok).toBe(false);
    expect(validate(committedConfig, { deployFlag: undefined }).ok).toBe(false);
    expect(validate(committedConfig, { deployFlag: "true" }).ok).toBe(false);
  });
});
