"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";

export function useWalletAuth() {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [authenticatedWallet, setAuthenticatedWallet] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const authenticate = useCallback(async () => {
    if (!address || !isConnected) return false;
    if (authenticatedWallet === address.toLowerCase()) return true;
    setLoading(true);
    try {
      const nonceResponse = await fetch("/api/auth/nonce", { cache: "no-store" });
      if (!nonceResponse.ok) return false;
      const nonce = await nonceResponse.json() as { nonce: string; issuedAt: string; expirationTime: string; origin: string; chainId: number };
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
      const verifyResponse = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
  }, [address, isConnected, authenticatedWallet, signMessageAsync]);

  useEffect(() => {
    if (!address || !isConnected) {
      setAuthenticatedWallet(null);
      return;
    }
    void authenticate();
  }, [address, isConnected, authenticate]);

  return { authenticated: authenticatedWallet === address?.toLowerCase(), authenticating: loading, authenticate };
}
