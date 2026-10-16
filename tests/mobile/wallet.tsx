// Browser-test wallet state only. No provider, connector, key or signing API.
import { createContext, useContext } from "react";
export const WalletContext = createContext({ address: "0x1111111111111111111111111111111111111111" as `0x${string}`, isConnected: true, chainId: 8453 });
export const useAccount = () => useContext(WalletContext);
