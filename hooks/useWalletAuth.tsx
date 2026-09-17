"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";

interface WalletAuthState {
  authenticated: boolean;
  authenticating: boolean;
  /** Resolves true once the connected wallet has a valid server session. */
  authenticate: () => Promise<boolean>;
}

// Server-authoritative auth state, shared across every component in the
// tree via a single Provider instance. Previously each call site (the
// global bootstrap AND RunGame) called this as a plain hook, so each got
// its own private `authenticatedWallet` state and its own mount-time
// effect — neither knew the other had already signed in, so navigating
// from Profile to the Game (a fresh RunGame mount) looked like a brand
// new, never-authenticated wallet and re-ran the full SIWE flow. A
// Context fixes that: there is exactly one `authenticatedWallet`/`loading`
// pair for the whole app, so every consumer sees the same state.
const WalletAuthContext = createContext<WalletAuthState | null>(null);

export function WalletAuthProvider({ children }: { children: React.ReactNode }) {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [authenticatedWallet, setAuthenticatedWallet] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Multiple consumers can call authenticate() around the same time (the
  // mount-time session check below, and a page's own "start" action). This
  // dedupes them: if a SIWE attempt is already in flight, later callers
  // await that same attempt instead of opening a second signature prompt.
  const inFlightRef = useRef<Promise<boolean> | null>(null);

  const performSiwe = useCallback(async (): Promise<boolean> => {
    if (!address || !isConnected) return false;
    setLoading(true);
    try {
      const nonceResponse = await fetch("/api/auth/nonce", { cache: "no-store", credentials: "include" });
      if (!nonceResponse.ok) return false;
      const nonce = (await nonceResponse.json()) as {
        nonce: string;
        issuedAt: string;
        expirationTime: string;
        origin: string;
        chainId: number;
      };
      const message = [
        `${new URL(nonce.origin).host} wants you to sign in with your Ethereum account:`,
        address,
        "",
        "Sign in to MPGR HUB.",
        "",
        `URI: ${nonce.origin}`,
        "Version: 1",
        `Chain ID: ${nonce.chainId}`,
        `Nonce: ${nonce.nonce}`,
        `Issued At: ${nonce.issuedAt}`,
        `Expiration Time: ${nonce.expirationTime}`,
      ].join("\n");
      const signature = await signMessageAsync({ message });
      // The server remains the sole authority: this call re-verifies the
      // nonce, the SIWE message, and the signature, and only then mints a
      // session cookie. Nothing here marks the wallet authenticated on the
      // client's say-so alone.
      const verifyResponse = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ address, message, signature }),
      });
      if (!verifyResponse.ok) return false;
      setAuthenticatedWallet(address.toLowerCase());
      return true;
    } catch {
      return false;
    } finally {
      setLoading(false);
    }
  }, [address, isConnected, signMessageAsync]);

  const authenticate = useCallback(async (): Promise<boolean> => {
    if (!address || !isConnected) return false;
    const lower = address.toLowerCase();
    if (authenticatedWallet === lower) return true;
    if (inFlightRef.current) return inFlightRef.current;
    const attempt = performSiwe().finally(() => {
      inFlightRef.current = null;
    });
    inFlightRef.current = attempt;
    return attempt;
  }, [address, isConnected, authenticatedWallet, performSiwe]);

  // A wallet connecting (or the page loading with a wallet already
  // connected) must not assume it needs a fresh signature. The server
  // already knows whether a valid, unexpired session covers this wallet —
  // ask it first via a read-only GET, and only fall back to a full SIWE
  // signature flow when the server says there is no valid session. This
  // is what actually stops "sign in on Profile, get asked again on Game":
  // by the time RunGame's own consumer of this context mounts, the
  // session check (or signature) has already run once, globally.
  //
  // Correction (this pass): this used to also set an external ref
  // (`resolvedWalletRef`) synchronously *before* the async check started,
  // to stop the effect re-running for a wallet it had already begun
  // checking. That is exactly the race this pass was asked to rule out —
  // React 18 StrictMode (enabled in next.config.mjs) deliberately runs
  // every effect as mount → cleanup → mount during development. The ref
  // got claimed by the first (throwaway) mount before its own cleanup
  // marked it cancelled; the second (real, kept) mount then saw the ref
  // already claimed and skipped entirely — so the session check silently
  // never ran, and the wallet could sit unauthenticated until something
  // else happened to call authenticate() directly. The dependency array
  // below (`[address, isConnected]`) already gives the correct semantics
  // on its own — React only re-runs this effect when the wallet or its
  // connection state actually changes — so no extra ref is needed, and
  // each invocation's own `cancelled` closure is what actually has to
  // guard against a stale, superseded check acting after the fact.
  useEffect(() => {
    if (!address || !isConnected) {
      setAuthenticatedWallet(null);
      return;
    }
    const lower = address.toLowerCase();
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/auth/session", { cache: "no-store", credentials: "include" });
        if (res.ok) {
          const data = (await res.json()) as { authenticated: boolean; wallet?: string };
          if (cancelled) return;
          if (data.authenticated && data.wallet?.toLowerCase() === lower) {
            setAuthenticatedWallet(lower);
            return;
          }
        }
      } catch {
        // Network hiccup on the session check — fall through and let the
        // normal SIWE flow (still fully server-verified) establish a
        // session instead of leaving the wallet stuck unauthenticated.
      }
      if (!cancelled) void authenticate();
    })();
    return () => {
      cancelled = true;
    };
    // authenticate intentionally omitted — it's recomputed from
    // address/isConnected/authenticatedWallet, and calling it here is
    // gated entirely by this effect's own re-run conditions (a real
    // wallet/connection change), not by a value that would need to be in
    // the dependency array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, isConnected]);

  const value = useMemo<WalletAuthState>(
    () => ({
      authenticated: authenticatedWallet === address?.toLowerCase(),
      authenticating: loading,
      authenticate,
    }),
    [authenticatedWallet, address, loading, authenticate]
  );

  return <WalletAuthContext.Provider value={value}>{children}</WalletAuthContext.Provider>;
}

export function useWalletAuth(): WalletAuthState {
  const ctx = useContext(WalletAuthContext);
  if (!ctx) {
    throw new Error("useWalletAuth must be used within a WalletAuthProvider");
  }
  return ctx;
}
