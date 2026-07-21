"use client";

import { useEffect } from "react";

export function MiniAppReady() {
  useEffect(() => {
    (async () => {
      try {
        const { sdk } = await import("@farcaster/miniapp-sdk");
        const inMiniApp = await sdk.isInMiniApp();
        if (inMiniApp) {
          await sdk.actions.ready();
        }
      } catch {
        // Not running inside Farcaster/Base App — normal browser, ignore.
      }
    })();
  }, []);

  return null;
}
