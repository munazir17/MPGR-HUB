import "server-only";

import { customActionProvider } from "@coinbase/agentkit";

import {
  AGENTKIT_CHAIN_ID,
  AGENTKIT_NETWORK_ID,
} from "./config";

const emptySchema = {
  parse(value: unknown) {
    return value && typeof value === "object" ? value : {};
  },
};

/**
 * MPGR-specific AgentKit custom action: the onchain policy the rest of
 * the Agent is required to follow. No chain write. No payment fields.
 */
export function mpgrOnchainPolicyProvider() {
  return customActionProvider({
    name: "mpgr_onchain_policy",
    description:
      "Returns the MPGR AgentKit onchain policy: Base mainnet only, read/prepare tools only, and every write/sign/payment must be confirmed by the user in the existing Confirm UX. Never signs.",
    schema: emptySchema as never,
    invoke: async () =>
      JSON.stringify({
        networkId: AGENTKIT_NETWORK_ID,
        chainId: AGENTKIT_CHAIN_ID,
        signing: "user-wallet-only",
        execute: false,
        autoPay: false,
        confirmationRequiredForWrites: true,
      }),
  });
}
