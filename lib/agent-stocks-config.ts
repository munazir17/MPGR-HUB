// lib/agent-stocks-config.ts
//
// Copy + default suggestions for the Base Stocks Agent screen (/agent).
//
// Product decision (locked): the agent's first screen is Coinbase
// wrapped assets + Coinbase Tokenized Stocks (B20) on Base. One line:
//
//   "Live Coinbase pairs on Base — see tape, verify 0xb200 contracts,
//    prepare USDC→stock swaps, pay $0.02 via x402 for the tape API."
//
// XP / season / holder tier / referral / run-game prompts are NOT
// default chips here. Those tools stay registered and will still answer
// if a user explicitly asks — they are simply never suggested.
//
// Import-safe from client components (no server-only, no fetches).

import {
  Activity,
  BadgeCheck,
  Landmark,
  LineChart,
  Repeat,
  Wallet,
  type LucideIcon,
} from "lucide-react";

import { BASE_STOCKS_DISCLAIMER } from "@/lib/markets/base-pairs";
import { X402_TAPE_PATH } from "@/lib/x402/x402-tape-info";

export const STOCKS_AGENT_TITLE = "Base Stocks Agent";

export const STOCKS_AGENT_SUBTITLE =
  "Live Coinbase wrapped assets and Coinbase Tokenized Stocks on Base.";

export const STOCKS_AGENT_SIGN_LINE = "Agent prepares the transaction. You sign.";

export { BASE_STOCKS_DISCLAIMER as STOCKS_AGENT_DISCLAIMER };

export const STOCKS_AGENT_EMPTY_STATE =
  "Ask for a pair, premium, or prepare a USDC → stock swap.";

export interface StocksAgentChip {
  id: string;
  label: string;
  prompt: string;
  icon: LucideIcon;
  /**
   * Optional click-time prompt builder (browser only). Used when the
   * prompt needs runtime context — e.g. the absolute https URL of this
   * deployment, which x402 discovery/prepare requires.
   */
  buildPrompt?: (origin: string) => string;
}

/** Default chips, exact product list. Labels may tighten, never swap in MPGR/XP chips. */
export const STOCKS_AGENT_CHIPS: readonly StocksAgentChip[] = [
  {
    id: "premium",
    label: "NVDAc premium vs feed",
    prompt: "What is the NVDAc premium of the DEX price vs the Chainlink feed right now?",
    icon: LineChart,
  },
  {
    id: "quote",
    label: "Quote 10 USDC → AAPLc",
    prompt: "Quote 10 USDC to AAPLc and prepare the swap.",
    icon: Repeat,
  },
  {
    id: "holdings",
    label: "My Coinbase stock holdings",
    prompt: "Show my Coinbase tokenized stock holdings on Base.",
    icon: Wallet,
  },
  {
    id: "verify",
    label: "Verify this 0xb200 contract",
    prompt:
      "Verify this contract for me: 0xb20000000000000000000078ee7ce2fE4908108C — is it an official Coinbase tokenized stock?",
    icon: BadgeCheck,
  },
  {
    id: "tape-x402",
    label: "Live tape snapshot ($0.02 x402)",
    prompt: "Prepare the $0.02 x402 payment for the live Base Stocks tape snapshot.",
    // x402_prepare_payment needs the absolute https resource URL —
    // build it from the deployment origin at click time.
    buildPrompt: (origin) =>
      origin
        ? `Prepare the $0.02 x402 payment for the live Base Stocks tape snapshot: discover and prepare the payment for ${origin}${X402_TAPE_PATH}`
        : "Prepare the $0.02 x402 payment for the live Base Stocks tape snapshot.",
    icon: Activity,
  },
  {
    id: "prepare-swap",
    label: "Prepare swap USDC → TSLAc",
    prompt: "Prepare a swap of 10 USDC to TSLAc on Base.",
    icon: Landmark,
  },
] as const;
