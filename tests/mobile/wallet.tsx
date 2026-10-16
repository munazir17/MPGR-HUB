// Browser-test wallet state only. No provider, connector, key or signing API.
import { useLayoutEffect, createContext, useContext } from "react";
export const WalletContext = createContext({ address: "0x1111111111111111111111111111111111111111" as `0x${string}`, isConnected: true, chainId: 8453 });
export const useAccount = () => {
  const account = useContext(WalletContext);
  useLayoutEffect(() => { (window as unknown as { simulatedAccount: typeof account }).simulatedAccount = account; }, [account]);
  return account;
};
export const useSwitchChain = () => ({ switchChain: () => {} });
export const useChainId = () => useContext(WalletContext).chainId;
const record = (method: string) => {
  const log = ((window as unknown as { simulatedWalletCalls?: string[] }).simulatedWalletCalls ??= []);
  log.push(method);
};
const typedSign = async () => { record("delegated-signature"); return ("0x" + "11".repeat(65)) as `0x${string}`; };
const messageSign = async () => { record("siwe-signature"); return ("0x" + "22".repeat(65)) as `0x${string}`; };
export const useSignTypedData = () => ({ signTypedDataAsync: typedSign });
export const useSignMessage = () => ({ signMessageAsync: messageSign });
