import { createConfig, http } from "wagmi";
import { base } from "wagmi/chains";
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
// The installed RainbowKit/wagmi version types `preference` as an object
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
  transports: {
    [base.id]: http(
      process.env.NEXT_PUBLIC_BASE_RPC_URL ?? "https://mainnet.base.org"
    ),
  },
  ssr: true,
});
