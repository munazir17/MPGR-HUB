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

export interface ReadOnlyStages {
  deriveDeployerAddress: () => string | null | Promise<string | null>;
  checkRoleSeparation: (deployerAddress: string) => boolean | Promise<boolean>;
  runRpcChecks: (deployerAddress: string) => void | Promise<void>;
}

export type DeployFlagValue = string | boolean | null | undefined;
export type DeployFlagValues = DeployFlagValue | DeployFlagValue[];

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
): StaticConfigValidation;

export function runReadOnlyChecksWhenDeploymentIsDisabled(
  environmentDeployFlagValues: DeployFlagValues,
  stages: ReadOnlyStages,
): Promise<ReadOnlyContinuationResult>;
