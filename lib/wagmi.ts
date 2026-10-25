import { createConfig, http } from "wagmi";
import { fallback } from "viem";
import { base } from "wagmi/chains";
import { browserRpcUrls } from "@/lib/chain/rpc-endpoints";
import { Attribution } from "ox/erc8021";
import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  base as baseSmartWallet,
  coinbaseWallet,
  metaMaskWallet,
  rainbowWallet,
  rabbyWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { farcasterMiniApp } from "@farcaster/miniapp-wagmi-connector";

// Dedicated Smart Wallet entry — passkey-only, no extension interception.
// The installed RainbowKit/wagmi version types preference as an object
// ({ options: ... }), matching the underlying wagmi coinbaseWallet
// connector's current signature — not a plain string.
baseSmartWallet.preference = { options: "smartWalletOnly" };

// Dedicated classic Coinbase Wallet entry — extension/app, EOA.
coinbaseWallet.preference = { options: "eoaOnly" };

const rainbowKitConnectors = connectorsForWallets(
  [
    {
      groupName: "Recommended",
      wallets: [baseSmartWallet, coinbaseWallet],
    },
    {
      groupName: "Other Wallets",
      wallets: [metaMaskWallet, rainbowWallet, rabbyWallet, walletConnectWallet],
    },
  ],
  {
    appName: "MPGR HUB",
    projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "2e1123b09e786a59f1af6b27668fda6",
  }
);

// Embedded Farcaster/Base App wallet connector.
// Deliberately NOT passed into connectorsForWallets — it must never appear
// as a selectable tile in the RainbowKit modal (avoids a duplicate entry
// and avoids being offered outside a Mini App host, where it can't work).
// Exported so MiniAppAutoConnect can target it directly.
export const farcasterConnector = farcasterMiniApp();

export const config = createConfig({
  connectors: [...rainbowKitConnectors, farcasterConnector],
  chains: [base],
  dataSuffix: Attribution.toDataSuffix({
    codes: ["bc_6w84im9m"],
  }),
  transports: {
    // Public fallback only. Server secrets (BASE_RPC_URL / BASE_RPC_URLS)
    // are never read here, so they cannot be bundled into the browser.
    // retryCount stays 0; lib/token/rpc-retry.ts remains the app retry.
    [base.id]: fallback(
      browserRpcUrls().map((url) => http(url, { retryCount: 0, timeout: 10_000 })),
      { retryCount: 0 },
    ),
  },
  ssr: true,
});
