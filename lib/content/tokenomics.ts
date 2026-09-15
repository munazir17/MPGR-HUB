export const TOKEN_FACTS = {
  name: "MoneyPaiger",
  symbol: "MPGR",
  network: "Base",
  maxSupply: "1,000,000,000",
  decimals: 18,
  inflation: "None",
  futureMinting: "None",
  privateSale: "None",
  vcAllocation: "None",
  lockedTeam: "None",
} as const;

export const INITIAL_DISTRIBUTION = [
  { id: "lp", label: "Liquidity pool (Base DEX)", amount: "900,000,000", share: "90%" },
  { id: "treasury", label: "Community treasury", amount: "100,000,000", share: "10%" },
] as const;

export const TREASURY_PROGRAMS = [
  { label: "Staking rewards", amount: "30,000,000" },
  { label: "Mini games", amount: "15,000,000" },
  { label: "Community quests", amount: "12,000,000" },
  { label: "Daily check-in", amount: "10,000,000" },
  { label: "Seasonal campaigns", amount: "10,000,000" },
  { label: "Referral program", amount: "8,000,000" },
  { label: "AI ecosystem rewards", amount: "5,000,000" },
  { label: "Community airdrops", amount: "5,000,000" },
  { label: "Ecosystem partnerships", amount: "3,000,000" },
  { label: "Emergency reserve", amount: "2,000,000" },
] as const;

export const TOKEN_UTILITY = [
  "Staking yield",
  "Lock / holder commitment",
  "Vault claims",
  "Game and season incentives (when gates are on)",
  "Referral and quest budgets",
  "Future governance weight",
  "Agent economic surface (swaps, x402, portfolio)",
] as const;
