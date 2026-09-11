"use client";

import { useEffect, useRef } from "react";
import { useAccount } from "wagmi";

const PENDING_REF_KEY = "mpgr_pending_ref_v2";
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const REFERRAL_CLICK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function submittedFlagKey(address: string) {
  return `mpgr_ref_submitted_v1_${address.toLowerCase()}`;
}

interface PendingReferral {
  referrer: string;
  capturedAt: number;
}

function readPending(): PendingReferral | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_REF_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingReferral;
    if (!parsed || !ADDRESS_RE.test(parsed.referrer) || typeof parsed.capturedAt !== "number") return null;
    if (Date.now() - parsed.capturedAt > REFERRAL_CLICK_TTL_MS) {
      window.sessionStorage.removeItem(PENDING_REF_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function ReferralCapture() {
  const { address, isConnected } = useAccount();
  const attemptedRef = useRef<string | null>(null);

  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const ref = params.get("ref");
      if (ref && ADDRESS_RE.test(ref)) {
        const pending: PendingReferral = { referrer: ref.toLowerCase(), capturedAt: Date.now() };
        window.sessionStorage.setItem(PENDING_REF_KEY, JSON.stringify(pending));
      }
    } catch {
      // sessionStorage unavailable — referral capture is best-effort.
    }
  }, []);

  useEffect(() => {
    if (!isConnected || !address) return;

    const dedupeKey = address.toLowerCase();
    if (attemptedRef.current === dedupeKey) return;

    let pending = readPending();
    try {
      if (window.localStorage.getItem(submittedFlagKey(address))) {
        pending = null;
      }
    } catch {
      pending = null;
    }

    if (!pending) return;
    if (pending.referrer === address.toLowerCase()) {
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
      body: JSON.stringify({ referrer: pending.referrer }),
    })
      .then((res) => {
        if (!res.ok) throw new Error("Referral registration failed");
        try {
          window.sessionStorage.removeItem(PENDING_REF_KEY);
          window.localStorage.setItem(submittedFlagKey(address), "1");
        } catch {
          /* ignore storage errors */
        }
      })
      .catch(() => {
        attemptedRef.current = null;
      });
  }, [address, isConnected]);

  return null;
}
