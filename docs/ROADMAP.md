# MPGR HUB Roadmap

This file is not a second roadmap.

The public page is `/roadmap`. The only feature list is [`lib/content/roadmap.ts`](../lib/content/roadmap.ts). Each item is **LIVE**, **IN PROGRESS**, **PLANNED** or **LONG-TERM VISION**. Nothing is marked live unless a route, engine or deployed contract in this repository implements it.

The older phase list that lived here (Lucky Spin, Memory Challenge, a future AI Agent, staking still "in development") does not match the product. It has been retired so it cannot contradict the page.

## What the page now tracks

- Core platform, wallet, PaigerSwap and tokenized stocks
- MPGR Agent, autonomy boundaries, research and trading
- MCP ecosystem (prepare-only server is live; ChatGPT and Claude connectors are not)
- Voice (speech into the existing Agent; voice never signs)
- Portfolio intelligence 2.0, smart automation, the x402 marketplace and the developer ecosystem — planned or in progress, not released products
- Gaming, MPGR Run, rewards, staking, token lock, quests, referrals, Base, security and infrastructure

## Trading fee

User-facing copy says **0.25% trading fee**.

The charge is still `floor(sellAmount × 25 / 10000)` of the sell token, on both buys and sells, collected once inside the swap. Display text does not change that arithmetic, the recipient, or the collection path.
