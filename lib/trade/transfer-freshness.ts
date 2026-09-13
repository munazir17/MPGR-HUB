import type { TransferProposal } from "./transfer-types";

export const TRANSFER_PROPOSAL_MAX_AGE_MS = 30_000;

export function isTransferProposalFresh(proposal: TransferProposal): boolean {
  const quotedAt = new Date(proposal.quotedAt).getTime();
  if (!Number.isFinite(quotedAt)) return false;
  return Date.now() - quotedAt < TRANSFER_PROPOSAL_MAX_AGE_MS;
}
