import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  EXPECTED_DEPLOYER,
  EXPECTED_EXECUTOR,
  decodeDeploymentFlagSource,
  isReadOnlyDeploymentFlagFalse,
  predictedCreateAddress,
  readOnlyDeploymentFlagStatus,
  runReadOnlyChecksWhenDeploymentIsDisabled,
  validateStaticConfig,
} from "./delegated-mainnet-preflight.mjs";

const committedConfig = JSON.parse(
  readFileSync("deployments/base-mainnet/delegated-deploy-config.json", "utf8"),
);
const disabledConfig = { ...committedConfig, mainnetDelegatedDeployEnabled: false };
const preflightWorkflow = readFileSync(".github/workflows/preflight-delegated-base-mainnet.yml", "utf8");
const preflightChecker = readFileSync("scripts/delegated-mainnet-preflight.mjs", "utf8");
const deployScript = readFileSync("script/DeployMPGRExecutorDelegatedBaseMainnet.s.sol", "utf8");

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
  it("passes read-only preflight only for the disabled committed-config posture", () => {
    const result = validate(disabledConfig);

    expect(result.ok).toBe(true);
    expect(result.checks.find(({ name }) => name === "config_deploy_flag")?.ok).toBe(true);
    expect(result.checks.find(({ name }) => name === "environment_deploy_flag")?.ok).toBe(true);
    expect(validate(disabledConfig, { deployFlag: false }).ok).toBe(true);
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
      disabledConfig,
      disabledConfig.owner,
      disabledConfig.feeRecipient,
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

  it("runs the dedicated Forge simulation with only a public deployer address and no broadcast path", () => {
    const simulationStart = deployScript.indexOf("    function simulate()");
    const simulationEnd = deployScript.indexOf("\n    function _validateSimulationPlan", simulationStart);
    expect(simulationStart).toBeGreaterThanOrEqual(0);
    expect(simulationEnd).toBeGreaterThan(simulationStart);
    const simulationEntry = deployScript.slice(simulationStart, simulationEnd);
    expect(simulationEntry).toContain("public view returns (address predictedExecutor)");
    expect(simulationEntry).not.toContain("_readConfig()");
    expect(simulationEntry).not.toContain("BASE_MAINNET_DEPLOYER_PRIVATE_KEY");
    expect(simulationEntry).not.toContain("BASE_MAINNET_BROADCASTER_PRIVATE_KEY");
    expect(simulationEntry).not.toContain("vm.startBroadcast");
    expect(simulationEntry).not.toContain("_startBroadcast");
    expect(simulationEntry).not.toContain("new MPGRExecutorDelegated");

    const simulationConfigStart = deployScript.indexOf("function _readSimulationConfig()");
    const simulationConfigEnd = deployScript.indexOf("function _simulationModeEnabled()", simulationConfigStart);
    const publicOnlyConfigReader = deployScript.slice(simulationConfigStart, simulationConfigEnd);
    expect(publicOnlyConfigReader).toContain("BASE_MAINNET_DEPLOYER_ADDRESS");
    expect(publicOnlyConfigReader).not.toContain("PRIVATE_KEY");

    const workflowStepStart = preflightWorkflow.indexOf("- name: Run key-free delegated deployment simulation (NO BROADCAST)");
    expect(workflowStepStart).toBeGreaterThanOrEqual(0);
    const simulationStep = preflightWorkflow.slice(workflowStepStart);
    expect(preflightWorkflow).toContain("id: read_only_mainnet_preflight");
    expect(simulationStep).toContain(
      "BASE_MAINNET_DEPLOYER_ADDRESS: ${{ steps.read_only_mainnet_preflight.outputs.deployer_address }}",
    );
    expect(simulationStep).toContain('MPGR_MAINNET_DELEGATED_DEPLOY_SIMULATION: "true"');
    expect(simulationStep).toContain("--sig 'simulate()'");
    expect(simulationStep.match(/^\s*-\s*name:/gm)).toHaveLength(1);
    expect(simulationStep).not.toContain("BASE_MAINNET_DEPLOYER_PRIVATE_KEY");
    expect(simulationStep).not.toContain("--broadcast");
    expect(preflightChecker).toContain('writeGitHubOutput("deployer_address", address)');
    expect(preflightChecker).toContain("appendFileSync(outputPath");

    const runStart = deployScript.indexOf("function run() external returns");
    const runBody = deployScript.slice(runStart, runStart + 900);
    expect(runBody.indexOf("require(!_simulationModeEnabled()") < runBody.indexOf("_readConfig()")).toBe(true);
    expect(deployScript).toContain('require(!_simulationModeEnabled(), "MPGR: simulation mode cannot broadcast")');
  });

  it("keeps the exact constructor pins and explicitly armed production posture in scope", () => {
    expect(committedConfig.mainnetDelegatedDeployEnabled).toBe(true);
    expect(committedConfig.owner).toBe("0xE0e0d239853c5F2Fe0a524d544eC9eB71fef486e");
    expect(committedConfig.feeRecipient).toBe("0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4");
    expect(committedConfig.feeBps).toBe(25);
    expect(committedConfig.maxFeeBps).toBe(100);
    expect(committedConfig.permit2).toBe("0x000000000022D473030F116dDEE9F6B43aC78BA3");
    expect(committedConfig.weth).toBe("0x4200000000000000000000000000000000000006");
    expect(committedConfig.tokens).toHaveLength(50);
    expect(committedConfig.routers).toHaveLength(2);
    expect(committedConfig.routers.map((router: { kindName: string }) => router.kindName)).toEqual([
      "AERODROME_SLIPSTREAM",
      "UNISWAP_V3_ROUTER02",
    ]);
    expect(preflightChecker).toContain("`${router.kindName}_factory`");
    expect(preflightChecker).toContain("`${router.kindName}_quoter`");
    expect(preflightChecker).toContain("`${router.kindName}_USDC_WETH_pool`");
    expect(committedConfig.denied.canaryWallet).toBe("0xBF6c574b9543967f0D528ae49603b0A7574a280b");
    expect(committedConfig.denied.sepolia).toHaveLength(9);
    expect(committedConfig.typedModules).toEqual([]);
  });

});

describe("post-arm read-only delegated Base Mainnet preflight", () => {
  it("passes read-only preflight for the reviewed armed committed-config posture", () => {
    expect(committedConfig.mainnetDelegatedDeployEnabled).toBe(true);

    const result = validateStaticConfig(
      committedConfig,
      committedConfig.owner,
      committedConfig.feeRecipient,
      "false",
      { armedPosture: true },
    );

    expect(result.ok).toBe(true);
    expect(result.checks.find(({ name }) => name === "config_deploy_flag")).toMatchObject({
      ok: true,
      detail: "true; reviewed armed posture",
    });
    expect(result.checks.find(({ name }) => name === "environment_deploy_flag")?.ok).toBe(true);
  });

  it("keeps the pre-arm expectation as the fail-closed default", () => {
    const owner = committedConfig.owner as string;
    const feeRecipient = committedConfig.feeRecipient as string;

    expect(validateStaticConfig(committedConfig, owner, feeRecipient, "false").ok).toBe(false);
    expect(validateStaticConfig(committedConfig, owner, feeRecipient, "false", {}).ok).toBe(false);
    expect(validateStaticConfig(committedConfig, owner, feeRecipient, "false", { armedPosture: false }).ok).toBe(false);
    expect(validateStaticConfig(committedConfig, owner, feeRecipient, "false", undefined).ok).toBe(false);
    expect(
      validateStaticConfig(committedConfig, owner, feeRecipient, "false", null as unknown as { armedPosture?: boolean })
        .ok,
    ).toBe(false);
    const stringPosture = JSON.parse('{"armedPosture":"true"}') as { armedPosture?: boolean };
    expect(validateStaticConfig(committedConfig, owner, feeRecipient, "false", stringPosture).ok).toBe(false);
    for (const result of [
      validateStaticConfig(committedConfig, owner, feeRecipient, "false"),
      validateStaticConfig(committedConfig, owner, feeRecipient, "false", { armedPosture: false }),
    ]) {
      expect(result.checks.find(({ name }) => name === "config_deploy_flag")).toMatchObject({
        ok: false,
        detail: "false; deployment remains disabled",
      });
    }
  });

  it("still requires false environment deployment flags and rejects a disabled config when armed", () => {
    const owner = committedConfig.owner as string;
    const feeRecipient = committedConfig.feeRecipient as string;

    const nonFalseEnvFlags: Array<string | boolean | undefined | string[]> = [undefined, "", "true", true, ["false", "true"]];
    for (const deployFlag of nonFalseEnvFlags) {
      const result = validateStaticConfig(committedConfig, owner, feeRecipient, deployFlag, { armedPosture: true });
      expect(result.ok).toBe(false);
      expect(result.checks.find(({ name }) => name === "environment_deploy_flag")?.ok).toBe(false);
    }

    const disabledArmed = validateStaticConfig(disabledConfig, owner, feeRecipient, "false", { armedPosture: true });
    expect(disabledArmed.ok).toBe(false);
    expect(disabledArmed.checks.find(({ name }) => name === "config_deploy_flag")?.ok).toBe(false);
  });

  it("pins the dedicated deployer and the predicted CREATE executor independently of the deployment guard", () => {
    expect(EXPECTED_DEPLOYER).toBe("0x954BFdf0b3A262D537c825a40F7ba960830be88A");
    expect(EXPECTED_EXECUTOR).toBe("0x39B1C6Ea88A01e70cbF4899BF3cEfB2c43cD32Bb");
    expect(predictedCreateAddress("0x954BFdf0b3A262D537c825a40F7ba960830be88A", 0n).toLowerCase()).toBe(
      "0x39b1c6ea88a01e70cbf4899bf3cefb2c43cd32bb",
    );
  });

  it("checks the predicted CREATE address and its virgin state with read-only RPC only", () => {
    expect(preflightChecker).toContain(
      'check(sameAddress(deployerAddress, EXPECTED_DEPLOYER), "deployer_matches_pinned"',
    );
    expect(preflightChecker).toContain(
      'check(sameAddress(predictedExecutor, EXPECTED_EXECUTOR), "predicted_create_address"',
    );
    expect(preflightChecker).toContain('"predicted_executor_empty_code"');
    expect(preflightChecker).toContain('"predicted_executor_nonce_zero"');
    expect(preflightChecker).toContain('"predicted_executor_native_balance_zero"');
    expect(preflightChecker).toContain("getCreateAddress");
    expect(preflightChecker).not.toContain("createWalletClient");
    expect(preflightChecker).not.toContain("sendTransaction");
    expect(preflightChecker).not.toContain("eth_sendTransaction");
  });

  it("declares the armed posture in the protected workflow and selects the armed simulation only when armed", () => {
    expect(preflightWorkflow).toContain(
      "branches: [arena/01a105ea-mpgr-hub, arena/01a10cb1-mpgr-hub, arena/b8096a0d-mpgr-hub, main]",
    );
    expect(preflightWorkflow).toContain("github.ref == 'refs/heads/main'");
    expect(preflightWorkflow).toContain(
      "MPGR_PREFLIGHT_ARMED_POSTURE: ${{ github.ref == 'refs/heads/main' || github.ref == 'refs/heads/arena/b8096a0d-mpgr-hub' }}",
    );
    expect(preflightWorkflow).toContain("--sig 'simulateArmed()'");
    expect(preflightWorkflow).toContain("--sig 'simulate()'");
    expect(preflightChecker).toContain("process.env.MPGR_PREFLIGHT_ARMED_POSTURE");

    const armedStart = deployScript.indexOf("    function simulateArmed()");
    const armedEnd = deployScript.indexOf("\n    function _validateSimulationPlan", armedStart);
    expect(armedStart).toBeGreaterThan(0);
    expect(armedEnd).toBeGreaterThan(armedStart);
    const armedEntry = deployScript.slice(armedStart, armedEnd);
    expect(armedEntry).toContain("public view returns (address predictedExecutor)");
    expect(armedEntry).toContain("simulationPreflightArmed(c, p)");
    expect(armedEntry).not.toContain("_readConfig()");
    expect(armedEntry).not.toContain("BASE_MAINNET_DEPLOYER_PRIVATE_KEY");
    expect(armedEntry).not.toContain("BASE_MAINNET_BROADCASTER_PRIVATE_KEY");
    expect(armedEntry).not.toContain("vm.startBroadcast");
    expect(armedEntry).not.toContain("_startBroadcast");
    expect(armedEntry).not.toContain("new MPGRExecutorDelegated");
    expect(deployScript).toContain("function simulationPreflightArmed(Config memory c, Pins memory p)");
    expect(deployScript).toContain('"MPGR: armed simulation requires committed deployment flag true"');
    expect(deployScript).toContain('console2.log("[SIMULATION] committed deployment flag:", committedDeployFlag);');
    expect(deployScript).toContain('"MPGR: simulation requires committed deployment flag false"');
    expect(deployScript).toContain('require(!_simulationModeEnabled(), "MPGR: simulation mode cannot broadcast")');
  });
});
