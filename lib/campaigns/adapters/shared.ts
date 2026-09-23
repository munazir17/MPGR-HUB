// lib/campaigns/adapters/shared.ts
//
// Helpers shared by every adapter (kept in their own module so adapters
// never import the registry that imports them — no circular edges).

import type { CampaignActionConfig } from "@/lib/campaigns/campaign-types";

/**
 * Manual-action numeric input → bounds-checked integer evidence.
 * Returns null when the input is missing, not an integer, or outside
 * the configured [min, max] range.
 */
export function collectNumericEvidence(
  action: CampaignActionConfig,
  payload: Record<string, unknown> | undefined,
): Record<string, number> | null {
  if (!action.numericInput) return {};
  const { field, min, max } = action.numericInput;
  const raw = payload?.[field];
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (!Number.isInteger(raw)) return null;
  if (raw < min || raw > max) return null;
  return { [field]: raw };
}
