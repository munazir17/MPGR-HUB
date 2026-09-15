import { NextResponse } from "next/server";
import { MPGR_TOKEN_ADDRESS } from "@/lib/chain/base";

const DEXSCREENER = `https://api.dexscreener.com/latest/dex/tokens/${MPGR_TOKEN_ADDRESS}`;

export const revalidate = 30;

export async function GET() {
  try {
    const res = await fetch(DEXSCREENER, {
      headers: { accept: "application/json" },
      next: { revalidate: 30 },
    });
    if (!res.ok) {
      return NextResponse.json({ error: "Market source unavailable" }, { status: 502 });
    }
    const data = (await res.json()) as {
      pairs?: Array<{
        chainId?: string;
        priceUsd?: string;
        priceChange?: { h24?: number };
        marketCap?: number;
        fdv?: number;
        liquidity?: { usd?: number };
      }>;
    };
    const pairs = Array.isArray(data.pairs) ? data.pairs : [];
    const basePairs = pairs.filter((p) => (p.chainId || "").toLowerCase() === "base");
    const pool = (basePairs.length ? basePairs : pairs)
      .slice()
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];

    if (!pool?.priceUsd) {
      return NextResponse.json({ error: "No live pair found" }, { status: 404 });
    }

    return NextResponse.json({
      priceUsd: Number(pool.priceUsd),
      change24h: typeof pool.priceChange?.h24 === "number" ? pool.priceChange.h24 : null,
      marketCap: typeof pool.marketCap === "number" ? pool.marketCap : pool.fdv ?? null,
      updatedAt: Date.now(),
      source: "DexScreener",
    });
  } catch {
    return NextResponse.json({ error: "Market fetch failed" }, { status: 502 });
  }
}
