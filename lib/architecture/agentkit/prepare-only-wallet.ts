import "server-only";

import { EvmWalletProvider } from "@coinbase/agentkit";
import { createPublicClient, http, type Address } from "viem";

import {
  AGENTKIT_NETWORK,
  AGENTKIT_VIEM_CHAIN,
  PREPARE_ONLY_ERROR,
  ZERO_ADDRESS,
  getAgentKitRpcUrl,
} from "./config";

function asAddress(value: string | undefined): Address {
  if (
    typeof value === "string" &&
    /^0x[0-9a-fA-F]{40}$/.test(value)
  ) {
    return value as Address;
  }
  return ZERO_ADDRESS;
}

/**
 * AgentKit wallet that can read Base and never sign or send.
 *
 * The user's Farcaster/wagmi wallet remains the only signer. This
 * provider exists so AgentKit action providers have a Base network
 * identity without receiving a private key or CDP wallet secret.
 *
 * Public-client typing is intentionally loose: AgentKit 0.10.4 ships
 * its own nested viem, which is structurally incompatible with the
 * app's viem types even though both work at runtime.
 */
export class PrepareOnlyEvmWalletProvider extends EvmWalletProvider {
  private readonly address: Address;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly publicClient: any;

  constructor(address?: string) {
    super();
    this.address = asAddress(address);
    this.publicClient = createPublicClient({
      chain: AGENTKIT_VIEM_CHAIN,
      transport: http(getAgentKitRpcUrl(), {
        retryCount: 0,
        timeout: 10_000,
      }),
    });
  }

  getAddress(): string {
    return this.address;
  }

  getNetwork() {
    return {
      protocolFamily: AGENTKIT_NETWORK.protocolFamily,
      networkId: AGENTKIT_NETWORK.networkId,
      chainId: AGENTKIT_NETWORK.chainId,
    };
  }

  getName(): string {
    return "mpgr-prepare-only";
  }

  async getBalance(): Promise<bigint> {
    return this.publicClient.getBalance({ address: this.address });
  }

  async nativeTransfer(_to: string, _value: string): Promise<string> {
    throw new Error(PREPARE_ONLY_ERROR);
  }

  async sign(_hash: `0x\( {string}`): Promise<`0x \){string}`> {
    throw new Error(PREPARE_ONLY_ERROR);
  }

  async signMessage(_message: string | Uint8Array): Promise<`0x${string}`> {
    throw new Error(PREPARE_ONLY_ERROR);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async signTypedData(_typedData: any): Promise<`0x${string}`> {
    throw new Error(PREPARE_ONLY_ERROR);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async signTransaction(_transaction: any): Promise<`0x${string}`> {
    throw new Error(PREPARE_ONLY_ERROR);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async sendTransaction(_transaction: any): Promise<`0x${string}`> {
    throw new Error(PREPARE_ONLY_ERROR);
  }

  async waitForTransactionReceipt(_txHash: `0x${string}`): Promise<never> {
    throw new Error(PREPARE_ONLY_ERROR);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async readContract(params: any): Promise<any> {
    return this.publicClient.readContract(params);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getPublicClient(): any {
    return this.publicClient;
  }

  toSigner(): never {
    throw new Error(PREPARE_ONLY_ERROR);
  }
}

export function createPrepareOnlyWallet(
  address?: string,
): PrepareOnlyEvmWalletProvider {
  return new PrepareOnlyEvmWalletProvider(address);
}

export function isPrepareOnlyError(error: unknown): boolean {
  return error instanceof Error && error.message === PREPARE_ONLY_ERROR;
}
