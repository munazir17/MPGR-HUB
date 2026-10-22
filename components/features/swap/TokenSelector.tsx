"use client";
import { useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { isAddress, type Address } from "viem";
import { Search, Check, Loader2 } from "lucide-react";
import { isNativeEthSentinel } from "@/lib/trade/trade-config";
import { TokenImportError } from "@/lib/trade/token-import";
import type { TradeTokenRef } from "@/lib/trade/trade-types";
import { SwapDialog } from "./SwapDialog";
import { swapCapabilityStatus } from "@/lib/swap/swap-capability";
import { TokenIcon, tokenName } from "./TokenIcon";
import { fetchSwapTokenHints } from "@/lib/swap/swap-token-hints";
import { importSwapToken } from "@/lib/swap/swap-inspection-client";
import { readSwapBalance } from "@/lib/swap/swap-wallet";
import { formatAtomicAmount } from "@/lib/trade/trade-format";
import type { SwapTokenHint } from "@/lib/swap/swap-token-discovery";

/** Concise, truthful row statuses. Full diagnostics live in the swap form's
 * optional technical details, not on every row. */
function rowStatus(status: { code: string; selectable: boolean }) {
  if (status.selectable || status.code !== "SAME_ASSET") return null;
  return { label: "Same asset", tone: "text-zinc-500" };
}
const shortAddress = (address: string) => `${address.slice(0, 10)}…${address.slice(-6)}`;

export function TokenSelector({ tokens, selected, onSelect, onClose, authorize, opposite, onImport }: { tokens: readonly TradeTokenRef[]; selected: string;
  opposite: TradeTokenRef; selectingPay: boolean; onImport: (t: TradeTokenRef) => void; onSelect: (t: TradeTokenRef) => void; onClose: () => void; authorize: (force?: boolean) => Promise<boolean> }) {
  const [hints, setHints] = useState<SwapTokenHint[]>([]);
  const [searched, setSearched] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [imported, setImported] = useState<TradeTokenRef | null>(null);
  const [tab, setTab] = useState<"all" | "stocks">("all");
  const [balances, setBalances] = useState<Record<string, { value: bigint; decimals: number }>>({});
  const { address, chainId, isConnected } = useAccount();
  const run = useRef(0); const pending = useRef<AbortController | null>(null);
  useEffect(() => () => { run.current++; pending.current?.abort(); }, []);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(async () => {
      if (!active) return;
      if (!address || !isConnected || chainId !== 8453) { setBalances({}); return; }
      const rows = await Promise.all(tokens.map(async (token) => {
        try { return [token.address.toLowerCase(), await readSwapBalance(address as Address, token)] as const; }
        catch { return null; }
      }));
      if (!active) return;
      const next: Record<string, { value: bigint; decimals: number }> = {};
      for (const row of rows) if (row) next[row[0]] = row[1];
      setBalances(next);
    });
    return () => { active = false; };
  }, [address, chainId, isConnected, tokens]);
  const addressSearch = search.trim().toLowerCase().startsWith("0x");
  const exact = isAddress(search.trim(), { strict: false });
  const results = tokens.filter(t => (tab === "stocks" ? t.kind === "b20-tokenized-stock" : true) && (addressSearch ? t.address.toLowerCase() === search.trim().toLowerCase()
    : [t.symbol, t.name].some(value => value.toLowerCase().includes(search.trim().toLowerCase()))));
  const validate = async (address = search.trim()) => {
    if (busy || !isAddress(address, { strict: false })) return;
    const current = ++run.current; const controller = new AbortController(); pending.current = controller;
    setBusy(true); setError(null);
    try {
      if (!(await authorize(sessionExpired))) { if (current === run.current) setError("Connect your wallet on Base and complete sign-in before validating a contract."); return; }
      if (current !== run.current) return;
      const token = await importSwapToken(address, controller.signal);
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
  const option = (t: TradeTokenRef) => {
    const status = swapCapabilityStatus(t.address, opposite.address, imported?.address.toLowerCase() === t.address.toLowerCase());
    const chip = rowStatus(status);
    const held = balances[t.address.toLowerCase()];
    const blocked = !status.selectable;
    return <button key={t.address} type="button" disabled={blocked} title={status.message} onClick={() => onSelect(t)}
      className="flex min-h-[64px] w-full items-center gap-3 rounded-2xl px-3 py-2 text-left hover:bg-white/5 focus-visible:outline focus-visible:outline-emerald-300 disabled:cursor-not-allowed disabled:opacity-65"
      aria-label={`Select ${t.symbol} ${t.address}`}>
      <TokenIcon token={t} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2"><bdi className="truncate text-sm font-semibold">{t.symbol}</bdi>
          {!t.verified && <span className="shrink-0 text-[10px] text-amber-300">Unverified</span>}
          <span data-testid={chip ? "token-route-unavailable" : undefined} className={`ml-auto shrink-0 text-[10px] ${chip?.tone ?? ""}`}>{chip?.label}</span></span>
        <span className="block truncate text-xs text-zinc-400">{tokenName(t.name)}</span>
        <span className="flex items-center justify-between gap-2">
          <span className="block truncate font-mono text-[10px] text-zinc-500" title={t.address}>{isNativeEthSentinel(t.address) ? "Native Base asset" : shortAddress(t.address)}</span>
          {held && <span className="shrink-0 text-[11px] text-zinc-200">{formatAtomicAmount(held.value.toString(), held.decimals, 4)}</span>}
        </span>
      </span>
      {selected.toLowerCase() === t.address.toLowerCase() && <Check size={18} className="shrink-0 text-emerald-300" />}
    </button>;
  };
  return <SwapDialog title="Select a token" onClose={onClose}>
    <label className="flex items-center gap-2 rounded-2xl border border-white/10 bg-black/15 px-3"><Search size={17} className="shrink-0 text-zinc-500" /><input autoFocus aria-label="Search tokens or Base contract" placeholder="Name, symbol or 0x…" value={search}
      className="min-h-12 min-w-0 flex-1 bg-transparent text-sm outline-none" maxLength={160}
      onChange={e => { run.current++; pending.current?.abort(); setBusy(false); setError(null); setImported(null); setHints([]); setSearched(false); setSearch(e.target.value); }} /></label>
    <div className="flex gap-2">
      {([["all", "All"], ["stocks", "Stocks"]] as const).map(([id, label]) => <button key={id} type="button" onClick={() => setTab(id)} className={`min-h-10 flex-1 rounded-xl text-sm ${tab === id ? "bg-white/10 text-white" : "text-zinc-400"}`}>{label}</button>)}
    </div>
    {addressSearch && !exact && <p role="alert" className="text-xs text-amber-300">Invalid address. Paste 0x and 40 hexadecimal characters.</p>}
    {!addressSearch && !results.length && <p className="py-5 text-sm text-zinc-400">No results. Paste an exact Base contract to validate a token.</p>}
    {addressSearch && exact && !imported && <div className="flex items-center gap-3 rounded-2xl border border-amber-300/15 bg-amber-300/5 p-3">
      <p className="min-w-0 flex-1 text-xs text-amber-100">Validate this Base ERC-20 by exact contract. A quote checks liquidity before any swap.</p>
      <button type="button" disabled={busy} onClick={() => void validate()} className="min-h-11 shrink-0 rounded-xl bg-white/10 px-3 text-sm font-medium">{busy ? <span className="flex items-center gap-2"><Loader2 size={16} className="animate-spin" />Validating…</span> : sessionExpired ? "Sign in and retry" : "Validate Base token"}</button>
    </div>}
    {!addressSearch && search.trim().length >= 2 && <button type="button" disabled={busy} onClick={() => void discover()} className="min-h-11 w-full rounded-xl bg-white/10 px-3 text-sm">{busy ? "Checking token list…" : sessionExpired ? "Sign in and search Base tokens" : "Search more Base tokens"}</button>}
    {!addressSearch && hints.length > 0 && <div className="space-y-3 rounded-xl border border-white/10 p-3">
      <p className="text-xs text-zinc-400">Found on the Uniswap Base token list. Check the exact contract before importing.</p>
      {hints.map(t => <div key={t.address} className="space-y-1 text-xs"><p><bdi>{t.symbol}</bdi> · <bdi>{t.name}</bdi></p><p className="break-all font-mono text-zinc-400">{t.address}</p><button type="button" disabled={busy} onClick={() => void validate(t.address)} className="min-h-11 text-emerald-300 underline">Check {t.symbol} on Base</button></div>)}
    </div>}
    {!addressSearch && searched && !hints.length && <p role="status" className="text-xs text-zinc-400">No additional matches on this list. Paste an exact Base contract to check a different token.</p>}
    {error && <p role="alert" className="break-words text-xs text-red-300">{error}</p>}
    <div className="max-h-[46dvh] space-y-1 overflow-y-auto pr-1">{[...results].sort((a, b) => {
      const left = balances[a.address.toLowerCase()]?.value ?? 0n;
      const right = balances[b.address.toLowerCase()]?.value ?? 0n;
      if (left === right) return 0;
      return left > right ? -1 : 1;
    }).map(option)}{imported && tab === "all" && !results.some(t => t.address.toLowerCase() === imported.address.toLowerCase()) && option(imported)}</div>
    {(imported || results.some(t => !t.verified)) && <p className="rounded-xl bg-amber-300/5 p-3 text-xs text-amber-200">Import is not endorsement. A live quote still has to find liquidity, and every executed swap collects the 0.25% Paiger fee.</p>}
  </SwapDialog>;
}
