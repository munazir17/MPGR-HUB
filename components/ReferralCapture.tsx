"use client";

import { useEffect, useRef } from "react";
import { useAccount } from "wagmi";

// Bug fix — persistent referral attribution.
//
// Step 1 (this component, on every page load): if the URL carries
// ?ref=0x..., stash the referrer address in sessionStorage. This is
// just a short-lived carrier across the landing click -> wallet
// connect flow — it is NOT the source of truth (that's Redis, via
// /api/referral — see lib/referral/referral-store.ts).
//
// Step 2 (this component, once a wallet connects): if a pending
// referrer is stashed, POST it once to /api/referral so the server can
// permanently attribute "this wallet -> referred by that wallet". The
// server enforces idempotency (a wallet can only ever be attributed
// once) and rejects self-referrals — this component just needs to make
// the one call; it never fabricates or increments a count itself.
//
// Mounted once at the app root (app/layout.tsx), same pattern as
// components/MiniAppAutoConnect.tsx / components/RecentPageTracker.tsx:
// a side-effect-only component with no rendered output.

const PENDING_REF_KEY = "mpgr_pending_ref_v1";
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function submittedFlagKey(address: string) {
  return `mpgr_ref_submitted_v1_${address.toLowerCase()}`;
}

export function ReferralCapture() {
  const { address, isConnected } = useAccount();
  const attemptedRef = useRef<string | null>(null);

  // Step 1 — capture ?ref= from the URL, once, on first load.
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const ref = params.get("ref");
      if (ref && ADDRESS_RE.test(ref)) {
        window.sessionStorage.setItem(PENDING_REF_KEY, ref.toLowerCase());
      }
    } catch {
      // sessionStorage unavailable (private mode, etc.) — referral
      // capture is best-effort and never blocks the rest of the app.
    }
  }, []);

  // Step 2 — once the referred wallet connects, register the referral.
  useEffect(() => {
    if (!isConnected || !address) return;

    const dedupeKey = address.toLowerCase();
    if (attemptedRef.current === dedupeKey) return;

    let pendingRef: string | null = null;
    try {
      pendingRef = window.sessionStorage.getItem(PENDING_REF_KEY);
      // Already submitted for this wallet in a prior session/visit —
      // skip the network call entirely (the server would no-op this
      // anyway via SETNX, this just avoids the redundant request).
      if (window.localStorage.getItem(submittedFlagKey(address))) {
        pendingRef = null;
      }
    } catch {
      pendingRef = null;
    }

    if (!pendingRef || !ADDRESS_RE.test(pendingRef)) return;
    if (pendingRef === address.toLowerCase()) {
      // Self-referral — nothing to submit, just clear it.
      try {
        window.sessionStorage.removeItem(PENDING_REF_KEY);
      } catch {
        // ignore
      }
      return;
    }

    attemptedRef.current = dedupeKey;

    fetch("/api/referral", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ referrer: pendingRef, referred: address }),
    })
      .catch(() => {
        // Best-effort — a failed request just means this wallet won't
        // be attributed this time; it does not affect any other
        // functionality.
      })
      .finally(() => {
        try {
          window.sessionStorage.removeItem(PENDING_REF_KEY);
          window.localStorage.setItem(submittedFlagKey(address), "1");
        } catch {
          // ignore
        }
      });
  }, [address, isConnected]);

  return null;
}
