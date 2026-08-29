import "server-only";

import {
  AgentKit,
  walletActionProvider,
  x402ActionProvider,
} from "@coinbase/agentkit";

import { mpgrOnchainPolicyProvider } from "./mpgr-action-provider";
import { createPrepareOnlyWallet } from "./prepare-only-wallet";

/**
 * Builds an AgentKit instance for Base with a prepare-only wallet.
 *
 * CDP API keys, if present in the environment, are never passed into
 * AgentKit.from() here — that path would create a CDP-hosted signer.
 * MPGR keeps signing on the user's connected wallet.
 */
export async function createMpgrAgentKit(options?: {
  walletAddress?: string;
}): Promise<AgentKit> {
  const walletProvider = createPrepareOnlyWallet(options?.walletAddress);

  return AgentKit.from({
    walletProvider,
    actionProviders: [
      walletActionProvider(),
      x402ActionProvider(),
      mpgrOnchainPolicyProvider(),
    ],
  });
}
