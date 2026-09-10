"use client";
import { useWalletAuth } from "@/hooks/useWalletAuth";
export function WalletAuthBootstrap() {
  useWalletAuth();
  return null;
}
