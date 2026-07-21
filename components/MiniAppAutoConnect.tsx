"use client";

import { useEffect } from "react";
import { useAccount, useConnect } from "wagmi";
import { farcasterConnector } from "@/lib/wagmi";

export function MiniAppAutoConnect() {
  const { isConnected } = useAccount();
  const { connect } = useConnect();

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const { sdk } = await import("@farcaster/miniapp-sdk");
        const inMiniApp = await sdk.isInMiniApp();
        if (cancelled || !inMiniApp) return;

        // Hides the Mini App loading splash screen
        await sdk.actions.ready();

        // Silently attach the embedded wallet — no modal, no external redirect
        if (!isConnected) {
          connect({ connector: farcasterConnector });
        }
      } catch {
        // Not inside a Farcaster/Base App host — plain browser, do nothing.
        // RainbowKit's normal ConnectButton handles everything from here.
      }
    })();

    return () => {
      cancelled = true;
    };
    // Runs once on mount by design — this is a one-time environment check,
    // not something that should re-run on every isConnected change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
