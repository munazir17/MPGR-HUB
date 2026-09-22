"use client";

import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";
import { config } from "@/lib/wagmi";
import { useState } from "react";
import { WalletAuthProvider } from "@/hooks/useWalletAuth";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={darkTheme({
            accentColor: "#2472EB",
            accentColorForeground: "#FFFFFF",
            borderRadius: "large",
          })}
          modalSize="compact"
        >
          {/* Single shared wallet-auth instance for the whole app — see
              hooks/useWalletAuth.tsx for why this must be one Provider
              rather than a plain hook called from multiple components. */}
          <WalletAuthProvider>{children}</WalletAuthProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
