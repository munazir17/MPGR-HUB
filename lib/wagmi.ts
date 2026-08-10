import { createConfig, http } from "wagmi";
import { base } from "wagmi/chains";
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

// ============================================================
// BASE BUILDER CODE / ERC-8021
// ============================================================

const DATA_SUFFIX = Attribution.toDataSuffix({
  codes: ["bc_nfsyuzw"],
});

// ============================================================
// WALLET PREFERENCES
// ============================================================

// Dedicated Smart Wallet entry — passkey-only, no extension interception.
baseSmartWallet.preference = {
  options: "smartWalletOnly",
};

// Dedicated classic Coinbase Wallet entry — extension/app, EOA.
coinbaseWallet.preference = {
  options: "eoaOnly",
};

// ============================================================
// RAINBOWKIT CONNECTORS
// ============================================================

const rainbowKitConnectors = connectorsForWallets(
  [
    {
      groupName: "Recommended",
      wallets: [baseSmartWallet, coinbaseWallet],
    },
    {
      groupName: "Other Wallets",
      wallets: [
        metaMaskWallet,
        rainbowWallet,
        rabbyWallet,
        walletConnectWallet,
      ],
    },
  ],
  {
    appName: "MPGR HUB",
    projectId:
      process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ??
      "2e1123b09e786a59f1af6b27668fda6",
  }
);

// ============================================================
// FARCASTER / BASE APP CONNECTOR
// ============================================================

// Embedded Farcaster/Base App wallet connector.
// Deliberately NOT passed into connectorsForWallets so it does not
// appear as a selectable tile in the RainbowKit modal.

export const farcasterConnector = farcasterMiniApp();

// ============================================================
// WAGMI CONFIG
// ============================================================

export const config = createConfig({
  connectors: [...rainbowKitConnectors, farcasterConnector],

  chains: [base],

  transports: {
    [base.id]: http(
      process.env.NEXT_PUBLIC_BASE_RPC_URL ??
        "https://mainnet.base.org"
    ),
  },

  // ERC-8021 Builder Code attribution.
  // This automatically attaches MPGR HUB's Builder Code
  // to supported transactions sent through Wagmi.
  dataSuffix: DATA_SUFFIX,

  ssr: true,
});
