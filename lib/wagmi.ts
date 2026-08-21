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
  transports: {
    // retryCount: 0 — viem's transport-level retry is disabled here so
    // lib/token/rpc-retry.ts's withRetry() is the single, coordinated
    // retry layer for every RPC call. Without this, viem's own default
    // (retryCount: 3, exponential backoff) retries underneath withRetry's
    // own maxAttempts, so one "logical" call (one getLogs chunk, one
    // readContract, etc.) can produce up to ~12 real HTTP requests before
    // withRetry ever sees a failure — amplification that's invisible to
    // the app's own retry diagnostics but still consumes real request
    // budget against the RPC provider, whichever URL
    // NEXT_PUBLIC_BASE_RPC_URL points at. No change to maxAttempts,
    // backoff strategy, or any call-site behavior — only removes the
    // duplicate inner layer.
    //
    // timeout: 10_000 — Reward Hub loading fix (bounded RPC timeout).
    // Every RPC call made anywhere in the app (staking reads, the staking
    // history scan's getLogs/getBlock calls, token reads, etc.) goes
    // through this single transport via wagmi's getClient(config), so one
    // bounded timeout here covers all of them without touching any
    // individual call site. Previously an unresponsive (not erroring,
    // just hanging) RPC request had no upper bound at this layer, which
    // could leave withRetry's per-attempt wait — and therefore whatever
    // loading state was awaiting it — unbounded in the pathological case.
    // 10s per attempt still leaves room for withRetry's own backoff/retry
    // cycle on top; it does not change retryCount (still 0, per above) or
    // add a second retry layer, only a ceiling on how long any single
    // attempt can hang.
    [base.id]: http(
      process.env.NEXT_PUBLIC_BASE_RPC_URL ?? "https://mainnet.base.org",
      { retryCount: 0, timeout: 10_000 }
    ),
  },
  ssr: true,
});
