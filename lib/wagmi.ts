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
// Cast against the property's own declared type rather than a bare string
// literal: TypeScript widens the RHS of assignments onto these wallet
// helpers' hybrid function+property types in some versions, so "smartWalletOnly"
// as a plain literal gets flagged even though it's the correct runtime value.
// `as typeof baseSmartWallet.preference` pulls the real type from the
// library itself, so this can't silently accept an invalid value.
baseSmartWallet.preference = "smartWalletOnly" as typeof baseSmartWallet.preference;

// Dedicated classic Coinbase Wallet entry — extension/app, EOA.
coinbaseWallet.preference = "eoaOnly" as typeof coinbaseWallet.preference;

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
    projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "REPLACE_ME",
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
