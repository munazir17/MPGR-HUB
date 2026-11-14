// lib/agent/research-portfolio.ts
//
// Additive, prepare-only research-to-portfolio helper for MPGR AGENT.
// Matches Base Stocks Maxxing Track 2.2 (Research-to-portfolio agents):
// user preferences / theme → researched allocation proposal → user reviews →
// individual swaps are still prepared and signed by the user.
//
// Does NOT execute, sign, or move funds. Safe to call from the agent
// reply path. Uses only the known Coinbase B20 tickers already supported
// by the agent.

export interface PortfolioAllocation {
  ticker: string;
  company: string;
  weightPct: number;
  rationale: string;
}

export interface ResearchPortfolioProposal {
  theme: string;
  title: string;
  summary: string;
  constraintsMet: string[];
  unavailable: string[];
  allocations: PortfolioAllocation[];
  sources: string[];
  nextSteps: string[];
  disclaimer: string;
}

const SUPPORTED_B20: Record<string, { company: string; themes: string[] }> = {
  NVDAc: { company: "NVIDIA", themes: ["ai", "tech", "semiconductor", "growth", "robotics"] },
  AAPLc: { company: "Apple", themes: ["tech", "consumer", "growth", "quality"] },
  METAc: { company: "Meta", themes: ["tech", "social", "ai", "growth"] },
  GOOGLc: { company: "Alphabet", themes: ["tech", "ai", "search", "growth"] },
  AMZNc: { company: "Amazon", themes: ["tech", "consumer", "ecommerce", "growth"] },
  MSFTc: { company: "Microsoft", themes: ["tech", "ai", "enterprise", "quality"] },
  TSLAc: { company: "Tesla", themes: ["ev", "robotics", "growth", "consumer"] },
  MSTRc: { company: "Strategy", themes: ["bitcoin", "crypto", "treasury"] },
  SPCXc: { company: "SpaceX", themes: ["space", "growth", "private"] },
  SNDKc: { company: "SanDisk", themes: ["tech", "storage", "semiconductor"] },
  NFLXc: { company: "Netflix", themes: ["consumer", "media", "growth"] },
};

const THEME_ALIASES: Record<string, string[]> = {
  ai: ["ai", "artificial intelligence", "machine learning", "gpu"],
  tech: ["tech", "technology", "big tech", "mega cap tech"],
  robotics: ["robotics", "robot", "automation"],
  ev: ["ev", "electric", "tesla", "auto"],
  consumer: ["consumer", "retail"],
  growth: ["growth", "high growth"],
  quality: ["quality", "blue chip", "defensive tech"],
  bitcoin: ["bitcoin", "btc", "crypto treasury"],
};

function detectTheme(prompt: string): string {
  const lower = prompt.toLowerCase();
  for (const [theme, aliases] of Object.entries(THEME_ALIASES)) {
    if (aliases.some((a) => lower.includes(a))) return theme;
  }
  if (lower.includes("portfolio") || lower.includes("allocation") || lower.includes("rebalance")) {
    return "tech";
  }
  return "tech";
}

function pickTickers(theme: string, max = 5): string[] {
  const scored = Object.entries(SUPPORTED_B20)
    .map(([ticker, meta]) => ({
      ticker,
      score: meta.themes.includes(theme) ? 2 : meta.themes.some((t) => THEME_ALIASES[theme]?.includes(t)) ? 1 : 0,
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.ticker.localeCompare(b.ticker));

  const picked = scored.slice(0, max).map((x) => x.ticker);
  if (picked.length === 0) {
    return ["NVDAc", "AAPLc", "MSFTc", "GOOGLc", "AMZNc"];
  }
  return picked;
}

export function buildResearchPortfolioProposal(rawPrompt: string): ResearchPortfolioProposal {
  const theme = detectTheme(rawPrompt);
  const tickers = pickTickers(theme);
  const equal = Math.floor(100 / tickers.length);
  const remainder = 100 - equal * tickers.length;

  const allocations: PortfolioAllocation[] = tickers.map((ticker, i) => {
    const meta = SUPPORTED_B20[ticker];
    const weight = equal + (i < remainder ? 1 : 0);
    return {
      ticker,
      company: meta.company,
      weightPct: weight,
      rationale: `${meta.company} (${ticker}) fits the ${theme} theme via Coinbase B20 on Base. Secondary-market exposure only; user confirms any swap.`,
    };
  });

  return {
    theme,
    title: `${theme.charAt(0).toUpperCase() + theme.slice(1)}-themed tokenized stock portfolio (research proposal)`,
    summary: `Based on your request I propose a simple equal-weight basket of supported Coinbase B20 tokens on Base that map to the "${theme}" theme. This is a research proposal only — nothing is signed or executed until you explicitly prepare and confirm individual USDC → stock swaps.`,
    constraintsMet: [
      "Uses only currently supported Coinbase Tokenized Stocks (B20) on Base",
      "Prepare-only: user must confirm every swap in their wallet",
      "Separates proposal from execution",
      "Flags that primary mint/redeem is AP-only",
    ],
    unavailable: [
      "Full real-time news/sentiment feed (not wired yet — proposal uses static theme mapping)",
      "Automatic rebalancing without per-swap confirmation",
      "Stocks outside the current B20 list",
    ],
    allocations,
    sources: [
      "Coinbase Tokenized Stocks / Base B20 listings",
      "MPGR AGENT supported ticker list (lib/agent-stocks-config + agent tools)",
      "Base Stocks Maxxing Track 2.2 research-to-portfolio pattern",
    ],
    nextSteps: [
      "Review the allocation above",
      "Ask me to quote or prepare a USDC → {ticker} swap for any line (e.g. \"Quote 10 USDC → NVDAc\")",
      "Or say \"prepare the first two legs\" and I will guide you through individual confirmations",
    ],
    disclaimer:
      "Not financial advice. Tokenized stocks are only available in eligible jurisdictions outside the U.S. Secondary-market trading on Base; primary mint/redeem restricted to Authorized Participants. Always verify contract addresses. You control signing.",
  };
}

export function formatResearchPortfolioReply(proposal: ResearchPortfolioProposal): string {
  const lines = proposal.allocations
    .map((a) => `• ${a.weightPct}% ${a.ticker} (${a.company}) — ${a.rationale}`)
    .join("\n");

  return [
    proposal.title,
    "",
    proposal.summary,
    "",
    "Proposed allocation:",
    lines,
    "",
    "Constraints met: " + proposal.constraintsMet.join("; ") + ".",
    "Currently unavailable: " + proposal.unavailable.join("; ") + ".",
    "",
    "Next: " + proposal.nextSteps[0] + ". " + proposal.nextSteps[1] + ".",
    "",
    proposal.disclaimer,
  ].join("\n");
}
