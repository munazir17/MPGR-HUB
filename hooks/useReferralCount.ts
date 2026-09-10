"use client";

import { useEffect, useState } from "react";

// Fetches the wallet's REAL referral count from the server (source of
// truth: lib/referral/referral-store.ts). This is intentionally a
// separate, tiny hook rather than a field on useXP()'s local record,
// since the local XP record's referralCount is a browser-local field
// that's never actually incremented — the server is what now knows how
// many wallets a given address has referred.
export function useReferralCount(address: string | undefined) {
  const [count, setCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!address) {
      setCount(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/referral?wallet=${address.toLowerCase()}`, { cache: "no-store" })
      .then(async (res) => {
        if (res.status === 401) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          const retry = await fetch(`/api/referral?wallet=${address.toLowerCase()}`, { cache: "no-store" });
          if (!retry.ok) throw new Error("failed");
          return retry.json();
        }
        return res.ok ? res.json() : Promise.reject(new Error("failed"));
      })
      .then((data: { count: number }) => {
        if (!cancelled) setCount(data.count);
      })
      .catch(() => {
        if (!cancelled) setCount(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [address]);

  return { count, loading };
}
