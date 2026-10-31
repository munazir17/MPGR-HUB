// Post-approval allowance checks. A confirmed receipt and a late RPC read are
// different states: the approval is not a failure just because the allowance
// has not shown up yet, and a failed read is never a reason to approve again.

export const APPROVAL_VERIFYING_LABEL = "Approval confirmed. Verifying allowance…";

export const APPROVAL_CHECKING_LABEL =
  "Approval confirmed. We're checking your wallet permission. Please wait a moment.";

/** Shown when the approval receipt succeeded and the allowance read is still unavailable. */
export const APPROVAL_VERIFICATION_DELAYED =
  "Your approval transaction is confirmed, but we couldn't refresh its status yet. Retry status check.";

export const APPROVAL_STILL_INSUFFICIENT =
  "Approval confirmed, but the actual allowance is still insufficient. Check the token approval and retry.";

export type PostApprovalAllowance = "verified" | "insufficient" | "delayed";

/** `null` means the read failed or has not caught up. It is not an insufficient allowance. */
export function classifyPostApprovalAllowance(allowance: bigint | null, required: bigint): PostApprovalAllowance {
  if (allowance === null) return "delayed";
  return allowance >= required ? "verified" : "insufficient";
}
