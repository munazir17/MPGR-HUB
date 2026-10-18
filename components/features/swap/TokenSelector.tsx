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
import { fetchSwapTokenHints } from "@/lib/swap/swap-token-hints";
import type { SwapTokenHint } from "@/lib/swap/swap-token-discovery";
export function TokenSelector({ tokens, selected, onSelect, onClose, authorize, opposite, selectingPay, onImport }: { tokens: readonly TradeTokenRef[]; selected: string;
  opposite: TradeTokenRef; selectingPay: boolean; onImport: (t: TradeTokenRef) => void; onSelect: (t: TradeTokenRef) => void; onClose: () => void; authorize: (force?: boolean) => Promise<boolean> }) {
  const [hints, setHints] = useState<SwapTokenHint[]>([]);
  const [searched, setSearched] = useState(false);
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
  const validate = async (address = search.trim()) => {
    if (busy || !isAddress(address, { strict: false })) return;
    const current = ++run.current; const controller = new AbortController(); pending.current = controller;
    setBusy(true); setError(null);
    try {
      if (!(await authorize(sessionExpired))) { if (current === run.current) setError("Connect your wallet on Base and complete sign-in before validating a contract."); return; }
      if (current !== run.current) return;
      const token = await importBaseToken(address, controller.signal);
      if (current === run.current) { setSearch(address); setImported(token); onImport(token); setSessionExpired(false); }
    } catch (e) { if (current === run.current) { if (e instanceof TokenImportError && e.status === 401) setSessionExpired(true); setError(e instanceof Error ? e.message : "Token validation failed."); } }
    finally { if (current === run.current) setBusy(false); }
  };
  const discover = async () => {
    if (busy) return;
    const current = ++run.current; const controller = new AbortController(); pending.current = controller;
    setBusy(true); setError(null); setHints([]); setSearched(false);
    try {
      if (!(await authorize(sessionExpired))) { if (current === run.current) setError("Connect your Base wallet and sign in to search more tokens."); return; }
      if (current !== run.current) return;
      const rows = await fetchSwapTokenHints(search.trim(), controller.signal);
      if (current === run.current) { setHints(rows.filter(t => !tokens.some(known => known.address.toLowerCase() === t.address.toLowerCase()))); setSearched(true); setSessionExpired(false); }
    } catch (e) { if (current === run.current) { if (e instanceof TokenImportError && e.status === 401) setSessionExpired(true); setError(e instanceof Error ? e.message : "Token search unavailable."); } }
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
      onChange={e => { run.current++; pending.current?.abort(); setBusy(false); setError(null); setImported(null); setHints([]); setSearched(false); setSearch(e.target.value); }} /></label>
    <p className="text-xs text-zinc-400">Base tokens · select by exact contract, not symbol alone. Get a live quote to check whether a pair can be swapped.</p>
    {addressSearch && !exact && <p role="alert" className="text-xs text-amber-300">Invalid address. Paste 0x and 40 hexadecimal characters.</p>}
    {!addressSearch && !results.length && <p className="py-5 text-sm text-zinc-400">No results. Paste an exact Base contract to validate a token.</p>}
    {addressSearch && exact && !imported && <div className="space-y-3 rounded-2xl border border-amber-300/15 bg-amber-300/5 p-4">
      <p className="text-xs text-amber-100">Validate contract metadata on Base before offering it for selection.</p>
      <button type="button" disabled={busy} onClick={() => void validate()} className="min-h-11 w-full rounded-xl bg-white/10 px-3 text-sm font-medium">{busy ? <span className="flex items-center justify-center gap-2"><Loader2 size={16} className="animate-spin" />Validating token…</span> : sessionExpired ? "Sign in and retry validation" : "Validate Base token"}</button>
    </div>}
    {!addressSearch && search.trim().length >= 2 && <button type="button" disabled={busy} onClick={() => void discover()} className="min-h-11 w-full rounded-xl bg-white/10 px-3 text-sm">{busy ? "Checking token list…" : sessionExpired ? "Sign in and search Base tokens" : "Search more Base tokens"}</button>}
    {!addressSearch && hints.length > 0 && <div className="space-y-3 rounded-xl border border-white/10 p-3">
      <p className="text-xs text-zinc-400">Found on the Uniswap Base token list. Check the exact contract before importing. Listing does not mean this token can be swapped here.</p>
      {hints.map(t => <div key={t.address} className="space-y-1 text-xs"><p><bdi>{t.symbol}</bdi> · <bdi>{t.name}</bdi></p><p className="break-all font-mono text-zinc-400">{t.address}</p><button type="button" disabled={busy} onClick={() => void validate(t.address)} className="min-h-11 text-emerald-300 underline">Check {t.symbol} on Base</button></div>)}
    </div>}
    {!addressSearch && searched && !hints.length && <p role="status" className="text-xs text-zinc-400">No additional matches on this list. Paste an exact Base contract to check a different token. Native assets on other chains are not Base tokens.</p>}
    {error && <p role="alert" className="break-words text-xs text-red-300">{error}</p>}
    <div className="max-h-[42dvh] overflow-y-auto">{!addressSearch && [...results].sort((a, b) => Number(!!issueFor(a)) - Number(!!issueFor(b))).map(option)}{imported && option(imported)}</div>
    {(imported || results.some(t => !t.verified)) && <p className="rounded-xl bg-amber-300/5 p-3 text-xs text-amber-200">Import is not endorsement. Metadata is not a safety check or proof of liquidity. Tokens may be malicious or unsellable. Execution still requires a supported, fee-compliant route.</p>}
  </SwapDialog>;
}
