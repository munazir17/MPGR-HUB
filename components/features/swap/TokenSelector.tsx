"use client";
import { useEffect, useRef, useState } from "react";
import { isAddress } from "viem";
import { Search, Check, Loader2 } from "lucide-react";
import { isNativeEthSentinel } from "@/lib/trade/trade-config";
import { importBaseToken, TokenImportError } from "@/lib/trade/token-import";
import type { TradeTokenRef } from "@/lib/trade/trade-types";
import { SwapDialog } from "./SwapDialog";
import { swapRouteIssue, swapCapabilityStatus } from "@/lib/swap/swap-capability";
import { TokenIcon, tokenName } from "./TokenIcon";
export function TokenSelector({ tokens, selected, onSelect, onClose, authorize, opposite, selectingPay, onImport }: { tokens: readonly TradeTokenRef[]; selected: string;
  opposite: TradeTokenRef; selectingPay: boolean; onImport: (t: TradeTokenRef) => void; onSelect: (t: TradeTokenRef) => void; onClose: () => void; authorize: (force?: boolean) => Promise<boolean> }) {
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [imported, setImported] = useState<TradeTokenRef | null>(null);
  const run = useRef(0); const pending = useRef<AbortController | null>(null);
  useEffect(() => () => { run.current++; pending.current?.abort(); }, []);
  const addressSearch = search.trim().toLowerCase().startsWith("0x");
  const exact = isAddress(search.trim(), { strict: false });
  const results = tokens.filter(t => addressSearch ? t.address.toLowerCase() === search.trim().toLowerCase()
    : [t.symbol, t.name].some(value => value.toLowerCase().includes(search.trim().toLowerCase())));
  const validate = async () => {
    if (busy || !exact) return;
    const current = ++run.current; const controller = new AbortController(); pending.current = controller;
    setBusy(true); setError(null);
    try {
      if (!(await authorize(sessionExpired))) { if (current === run.current) setError("Connect your wallet on Base and complete sign-in before validating a contract."); return; }
      if (current !== run.current) return;
      const token = await importBaseToken(search.trim(), controller.signal);
      if (current === run.current) { setImported(token); onImport(token); setSessionExpired(false); }
    } catch (e) { if (current === run.current) { if (e instanceof TokenImportError && e.status === 401) setSessionExpired(true); setError(e instanceof Error ? e.message : "Token validation failed."); } }
    finally { if (current === run.current) setBusy(false); }
  };
  const issueFor = (t: TradeTokenRef) => selectingPay ? swapRouteIssue(t.address, opposite.address) : swapRouteIssue(opposite.address, t.address);
  const option = (t: TradeTokenRef) => {
    const issue = issueFor(t);
    const status = swapCapabilityStatus(t.address, opposite.address, imported?.address.toLowerCase() === t.address.toLowerCase());
    return <button type="button" key={t.address} disabled={!!issue} title={status.message} onClick={() => onSelect(t)}
    className="flex min-h-[76px] w-full items-center gap-3 rounded-2xl px-3 py-3 text-left hover:bg-white/5 focus-visible:outline focus-visible:outline-emerald-300 disabled:cursor-not-allowed disabled:opacity-65" aria-label={`Select ${t.symbol} ${t.address}`}>
    <TokenIcon token={t} /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold"><bdi>{t.symbol}</bdi>{!t.verified && <span className="ml-2 text-[10px] font-normal text-amber-300">Unverified</span>}</span>
      <span className="block truncate text-xs text-zinc-400">{tokenName(t.name)}</span>
      <span className="block break-all font-mono text-[10px] text-zinc-500">{isNativeEthSentinel(t.address) ? "Native Base asset · no ERC-20 contract" : t.address}</span><span data-testid={issue ? "token-route-unavailable" : "token-route-status"} className="mt-1 block text-[10px] text-amber-200">{status.message}</span></span>
    {selected.toLowerCase() === t.address.toLowerCase() && <Check size={18} className="shrink-0 text-emerald-300" />}
  </button>;
  };
  return <SwapDialog title="Select a token" onClose={onClose}>
    <label className="flex items-center gap-2 rounded-2xl border border-white/10 bg-black/15 px-3"><Search size={17} className="shrink-0 text-zinc-500" /><input autoFocus aria-label="Search tokens or Base contract" placeholder="Name, symbol or 0x…" value={search}
      className="min-h-12 min-w-0 flex-1 bg-transparent text-sm outline-none" maxLength={160}
      onChange={e => { run.current++; pending.current?.abort(); setBusy(false); setError(null); setImported(null); setSearch(e.target.value); }} /></label>
    <p className="text-xs text-zinc-400">Base tokens · select by exact contract, not symbol alone. Registered routes still require a live quote.</p>
    {addressSearch && !exact && <p role="alert" className="text-xs text-amber-300">Invalid address. Paste 0x and 40 hexadecimal characters.</p>}
    {!addressSearch && !results.length && <p className="py-5 text-sm text-zinc-400">No results. Paste an exact Base contract to validate a token.</p>}
    {addressSearch && exact && !imported && <div className="space-y-3 rounded-2xl border border-amber-300/15 bg-amber-300/5 p-4">
      <p className="text-xs text-amber-100">Validate contract metadata on Base before offering it for selection.</p>
      <button type="button" disabled={busy} onClick={validate} className="min-h-11 w-full rounded-xl bg-white/10 px-3 text-sm font-medium">{busy ? <span className="flex items-center justify-center gap-2"><Loader2 size={16} className="animate-spin" />Validating token…</span> : sessionExpired ? "Sign in and retry validation" : "Validate Base token"}</button>
    </div>}
    {error && <p role="alert" className="break-words text-xs text-red-300">{error}</p>}
    <div className="max-h-[42dvh] overflow-y-auto">{!addressSearch && [...results].sort((a, b) => Number(!!issueFor(a)) - Number(!!issueFor(b))).map(option)}{imported && option(imported)}</div>
    {(imported || results.some(t => !t.verified)) && <p className="rounded-xl bg-amber-300/5 p-3 text-xs text-amber-200">Import is not endorsement. Metadata is not a safety check or proof of liquidity. Tokens may be malicious or unsellable. Execution still requires a supported, fee-compliant route.</p>}
  </SwapDialog>;
}
