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
}

export function validateStaticConfig(
  config: unknown,
  environmentOwner: string | undefined,
  environmentFeeRecipient: string | undefined,
  environmentDeployFlag: string | undefined,
): StaticConfigValidation;

export function runReadOnlyChecksWhenDeploymentIsDisabled(
  environmentDeployFlag: string | undefined,
  continueReadOnlyChecks: () => void | Promise<void>,
): Promise<ReadOnlyContinuationResult>;
