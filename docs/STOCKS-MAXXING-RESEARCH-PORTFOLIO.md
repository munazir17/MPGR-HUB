# Stocks Maxxing — Research-to-Portfolio (Track 2.2)

Additive feature for Base **Stocks Maxxing** competition, **Agentic Stock Finance** track, idea **2.2 Research-to-portfolio agents**.

## What it does

- User asks for a theme / preference (AI, tech, robotics, EV, etc.).
- Agent produces a **researched proposal**: allocation of supported Coinbase B20 tokenized stocks on Base, rationale, constraints met, and what is currently unavailable.
- **Prepare-only**: nothing is signed or executed. User then asks for individual `Quote / Prepare USDC → {ticker}` swaps and confirms each one in their wallet.
- Separates facts (supported tickers), assumptions (static theme mapping), and opinions (suggested weights).

## How to demo

1. Open the Home agent.
2. Click the new chip **"AI / tech theme portfolio"** or type:
   - `Build me a research portfolio of tokenized stocks for the AI theme`
   - `Propose a robotics allocation on Base stocks`
3. Agent replies with a clear allocation + next steps.
4. Follow up with an existing chip or prompt such as `Quote 10 USDC → NVDAc` to show the prepare-and-confirm path.

## Safety

- No new execution path.
- No private keys, no auto-signing, no silent rebalancing.
- Uses only the existing B20 ticker set already supported by the agent.
- Does not change trade, x402, autonomy, or XP flows.

## Competition fit

Matches the requested "Show us: a brief becoming a sourced proposal and an approved portfolio, including a constraint the agent refuses to break."

The constraint that is always respected: **user must explicitly confirm every swap**.
