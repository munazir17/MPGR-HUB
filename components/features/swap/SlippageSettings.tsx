"use client";
import { useState } from "react";
import { parseSlippagePercent, slippagePercent } from "@/lib/swap/swap-policy";
import { SwapDialog } from "./SwapDialog";
export function SlippageSettings({ bps, onApply, onClose }: { bps: number; onApply: (bps: number) => void; onClose: () => void }) {
  const [custom, setCustom] = useState(slippagePercent(bps));
  const parsed = parseSlippagePercent(custom);
  return <SwapDialog title="Swap settings" onClose={onClose}>
    <div><h3 className="text-sm font-medium">Slippage tolerance</h3><p className="mt-2 text-xs leading-relaxed text-zinc-400">Maximum permitted output change. Quotes and transaction minimums are rebuilt when this changes. We never increase it automatically.</p></div>
    <div className="grid grid-cols-3 gap-2">{[10, 50, 100].map(value => <button type="button" key={value} aria-pressed={parsed === value} onClick={() => setCustom(slippagePercent(value))}
      className={`min-h-12 rounded-xl border text-sm ${parsed === value ? "border-emerald-300/50 bg-emerald-300/10 text-emerald-200" : "border-white/10 text-zinc-300"}`}>{slippagePercent(value)}%</button>)}</div>
    <label className="block text-xs text-zinc-400">Custom slippage (%)<input aria-label="Custom slippage (%)" value={custom} inputMode="decimal" maxLength={6} onChange={e => setCustom(e.target.value)} className="mt-2 min-h-12 w-full rounded-xl border border-white/10 bg-white/5 px-3 text-base text-white outline-emerald-300" /></label>
    {parsed === null && <p role="alert" className="text-xs text-red-300">Enter 0.01%–5%, with at most two decimal places.</p>}
    {parsed !== null && parsed > 100 && <p role="alert" className="text-xs text-amber-300">High slippage: this permits a larger loss to price movement or adverse execution. Consider a lower tolerance.</p>}
    <p className="text-xs text-zinc-500">Default 1% follows the existing supported route configuration. Stored for this browser session, not silently changed at execution.</p>
    <button type="button" disabled={parsed === null} onClick={() => { if (parsed !== null) onApply(parsed); }} className="min-h-12 w-full rounded-xl bg-emerald-300 font-semibold text-[#071710] disabled:opacity-40">Apply slippage</button>
  </SwapDialog>;
}
