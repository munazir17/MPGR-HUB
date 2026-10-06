export interface StaticConfigCheck {
  ok: boolean;
  name: string;
  detail: string;
}

export interface StaticConfigValidation {
  ok: boolean;
  checks: StaticConfigCheck[];
}

export interface ReadOnlyContinuationResult {
  ok: boolean;
  continued: boolean;
  stage: "deployment-flag" | "deployer" | "roles" | "rpc";
}

export interface ReadOnlyContinuationOptions {
  armedPosture?: boolean;
}

export type DeploymentAuthorizationState = "missing" | "disarmed" | "armed" | "conflict" | "invalid";

export interface DeploymentAuthorization {
  state: DeploymentAuthorizationState;
  configuredSources: number;
  armed: boolean;
  disarmed: boolean;
  explicit: boolean;
}

export declare const DEPLOY_FLAG_STATES: {
  readonly MISSING: "missing";
  readonly DISARMED: "disarmed";
  readonly ARMED: "armed";
  readonly CONFLICT: "conflict";
  readonly INVALID: "invalid";
};

export function readDeploymentAuthorization(
  environmentDeployFlagValues: DeployFlagValues,
): DeploymentAuthorization;

export function deploymentAuthorizationExpectation(
  authorization: DeploymentAuthorization,
  armedPosture?: boolean,
): { ok: boolean; detail: string };

export function runReadOnlyChecksForDeclaredPosture(
  environmentDeployFlagValues: DeployFlagValues,
  stages: ReadOnlyStages,
  options?: ReadOnlyContinuationOptions,
): Promise<ReadOnlyContinuationResult>;

export interface ReadOnlyStages {
  deriveDeployerAddress: () => string | null | Promise<string | null>;
  checkRoleSeparation: (deployerAddress: string) => boolean | Promise<boolean>;
  runRpcChecks: (deployerAddress: string) => void | Promise<void>;
}

export type DeployFlagValue = string | boolean | null | undefined;
export type DeployFlagValues = DeployFlagValue | DeployFlagValue[];

export interface ValidateStaticConfigOptions {
  armedPosture?: boolean;
}

export declare const EXPECTED_DEPLOYER: string;
export declare const EXPECTED_EXECUTOR: string;

export function predictedCreateAddress(deployerAddress: string, nonce?: bigint): string;

export function decodeDeploymentFlagSource(serializedValue: string | null | undefined): string | undefined;

export function readOnlyDeploymentFlagStatus(environmentDeployFlagValues: DeployFlagValues): {
  ok: boolean;
  configuredSources: number;
  detail: string;
};

export function isReadOnlyDeploymentFlagFalse(environmentDeployFlagValues: DeployFlagValues): boolean;

export function validateStaticConfig(
  config: unknown,
  environmentOwner: string | undefined,
  environmentFeeRecipient: string | undefined,
  environmentDeployFlagValues: DeployFlagValues,
  options?: ValidateStaticConfigOptions,
): StaticConfigValidation;

/**
 * Alias of `runReadOnlyChecksForDeclaredPosture`, kept for existing importers. Despite the legacy
 * name it is posture-aware: an explicitly disarmed environment always continues, an explicitly
 * armed one continues only when `options.armedPosture` is true, and missing/invalid/conflicting
 * configuration always fails closed.
 */
export declare const runReadOnlyChecksWhenDeploymentIsDisabled: typeof runReadOnlyChecksForDeclaredPosture;
