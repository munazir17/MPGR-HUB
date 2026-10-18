"use client";
import { useEffect, useRef, useState } from "react";
import { inspectSwapLiquidity } from "@/lib/swap/swap-inspection-client";
import { TokenImportError } from "@/lib/trade/token-import";
import type { SwapLiquidityResult } from "@/lib/swap/swap-liquidity";
import type { TradeTokenRef } from "@/lib/trade/trade-types";
export function SwapLiquidityInspection({ from, to, authorize }: { from: TradeTokenRef; to: TradeTokenRef; authorize: (force?: boolean) => Promise<boolean> }) {
  const [result, setResult] = useState<SwapLiquidityResult | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [expiredSession, setExpiredSession] = useState(false); const [now, setNow] = useState(Date.now);
  const run = useRef(0); const pending = useRef<AbortController | null>(null);
  useEffect(() => () => { run.current++; pending.current?.abort(); }, []);
  useEffect(() => { if (!result) return; const timer = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(timer); }, [result]);
  const inspect = async () => {
    if (busy) return;
    const current = ++run.current; const controller = new AbortController(); pending.current = controller;
    setBusy(true); setError(null); setResult(null);
    try {
      if (!(await authorize(expiredSession))) { if (current === run.current) setError("Connect on Base and sign in to inspect liquidity."); return; }
      if (current !== run.current) return;
      const data = await inspectSwapLiquidity(from.address, to.address, controller.signal);
      if (current === run.current) { setResult(data); setNow(Date.now()); setExpiredSession(false); }
    } catch (e) { if (current === run.current) { if (e instanceof TokenImportError && e.status === 401) setExpiredSession(true); setError(e instanceof Error ? e.message : "Base liquidity inspection is unavailable."); } }
    finally { if (current === run.current) setBusy(false); }
  };
  const fresh = result && now < result.snapshot.expiresAt;
  return <section aria-label="Read-only liquidity inspection" className="space-y-3 rounded-2xl border border-emerald-300/20 bg-emerald-300/5 p-3 text-xs">
    <h3 className="font-semibold">Inspect liquidity: <bdi>{from.symbol}</bdi> → <bdi>{to.symbol}</bdi></h3>
    <p className="break-all font-mono text-[10px] text-zinc-400">{from.address} → {to.address}</p>
    <p className="text-zinc-300">Checks canonical pools directly on Base, including two-hop paths via USDC/WETH. No approval, swap or trading permission is requested.</p>
    <button type="button" disabled={busy} onClick={() => void inspect()} className="min-h-11 w-full rounded-xl bg-white/10 px-3 font-medium">{busy ? "Reading Base pools…" : expiredSession ? "Sign in and retry liquidity check" : result ? "Refresh liquidity inspection" : "Check liquidity on Base"}</button>
    {error && <p role="alert" className="text-red-300">{error}</p>}
    {result && <div role="status" className="space-y-2">
      {!fresh ? <p className="text-amber-200">Liquidity snapshot expired. Refresh before relying on it.</p> : <>
        {result.partial && <p className="text-amber-200">Some sources could not be verified. Results are incomplete; this is not a missing-liquidity verdict.</p>}
        <p>{result.paths.length ? `${result.paths.length} direct / two-hop pool paths found. Not executable quotes.` : "No active path found within this bounded search. Other pools, tiers or venues may exist."}</p>
        {result.paths.map((path, i) => <div key={i} className="rounded-xl border border-white/10 p-2"><p>{path.tokens.length === 2 ? "Direct pool path" : "Two-hop pool path"} · {path.poolsPerHop.map(h => h.length).join(" / ")} pool options per hop</p><p className="break-all font-mono text-[10px] text-zinc-400">{path.tokens.join(" → ")}</p></div>)}
        {result.observations.filter(o => o.pool && o.status === "active-liquidity").map((o, i) => <div key={`${o.pool}:${i}`} className="rounded-xl bg-black/20 p-2"><p>{o.venue} · {typeof o.key === "boolean" ? o.key ? "stable" : "volatile" : o.venue === "slipstream" ? `spacing ${o.key}` : o.venue === "uniswap-v3" ? `fee tier ${o.key}` : "constant product"}</p><p className="break-all font-mono text-[10px] text-zinc-400">{o.tokenA} ↔ {o.tokenB}</p><a href={`https://basescan.org/address/${o.pool}`} target="_blank" rel="noreferrer" className="block min-h-11 break-all py-2 font-mono text-[10px] text-emerald-300 underline">Pool: {o.pool}</a></div>)}
        <p className="break-words text-zinc-400">{result.scope}</p><p className="text-zinc-400">Base block {result.snapshot.blockNumber}. Refreshable 30-second snapshot.</p>
      </>}
      <p className="text-amber-200">Discovery only. No amount-specific quote or gas estimate. Trading requires supported methods, permissions, fresh simulation and an atomically verified 25bps fee to the fixed recipient. The current deployed Executor has mutable fee terms; this inspection cannot authorize a new route.</p>
    </div>}
  </section>;
}
