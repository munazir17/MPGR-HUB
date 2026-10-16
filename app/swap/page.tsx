import type { Metadata } from "next";
import { SwapExperience } from "@/components/features/swap/SwapExperience";
export const metadata: Metadata = { title: "MPGR Swap | MPGR HUB", description: "Wallet-confirmed manual swaps on Base." };
export default function SwapPage() { return <SwapExperience />; }
