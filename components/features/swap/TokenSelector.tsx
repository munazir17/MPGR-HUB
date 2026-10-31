"use client";
import { useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { isAddress, formatUnits, type Address } from "viem";
import { Search, Check, Loader2 } from "lucide-react";
import { BASE_WETH, isNativeEthSentinel } from "@/lib/trade/trade-config";
import { TokenImportError } from "@/lib/trade/token-import";
import type { TradeTokenRef } from "@/lib/trade/trade-types";
import { SwapDialog } from "./SwapDialog";
import { swapCapabilityStatus } from "@/lib/swap/swap-capability";
import { TokenIcon, tokenName } from "./TokenIcon";
import { fetchSwapTokenHints } from "@/lib/swap/swap-token-hints";
import { importSwapToken } from "@/lib/swap/swap-inspection-client";
import { readSwapBalance } from "@/lib/swap/swap-wallet";
import { formatAtomicAmount } from "@/lib/trade/trade-format";
import listedTokens from "@/lib/swap/base-listed-tokens.json";
import type { SwapTokenHint } from "@/lib/swap/swap-token-discovery";

/** Concise, truthful row statuses. Full diagnostics live in the swap form's
 * optional technical details, not on every row. */
function rowStatus(status: { code: string; selectable: boolean }) {
  if (status.selectable || status.code !== "SAME_ASSET") return null;
  return { label: "Same asset", tone: "text-zinc-500" };
}
const shortAddress = (address: string) => `${address.slice(0, 10)}…${address.slice(-6)}`;
const listed = listedTokens as readonly { address: Address; symbol: string; name: string; decimals: number }[];
const listedMatch = (query: string, known: readonly TradeTokenRef[]): TradeTokenRef[] => {
  const q = query.trim().toLowerCase();
  if (q.length < 2 || q.startsWith("0x")) return [];
  const have = new Set(known.map((token) => token.address.toLowerCase()));
  return listed.filter((token) => !have.has(token.address.toLowerCase()) && (token.symbol.toLowerCase().includes(q) || token.name.toLowerCase().includes(q)))
    .sort((a, b) => Number(b.symbol.toLowerCase() === q) - Number(a.symbol.toLowerCase() === q) || a.symbol.localeCompare(b.symbol))
    .slice(0, 20)
    .map((token) => ({ address: token.address, symbol: token.symbol, name: token.name, decimals: token.decimals, kind: "erc20" as const, verified: false }));
};
const formatUsd = (value: number) => value >= 1000
  ? `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
  : value >= 1
    ? `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `$${value.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;

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
  const [prices, setPrices] = useState<Record<string, number>>({});
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
  useEffect(() => {
    let active = true;
    const weth = BASE_WETH.toLowerCase();
    const queried = [...new Set(tokens.map((token) => isNativeEthSentinel(token.address) ? weth : token.address.toLowerCase()))];
    void (async () => {
      const next: Record<string, number> = {};
      for (let index = 0; index < queried.length; index += 30) {
        const batch = queried.slice(index, index + 30);
        try {
          const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${batch.join(",")}`);
          if (!response.ok) continue;
          const body = await response.json() as { pairs?: { chainId?: string; priceUsd?: string; liquidity?: { usd?: number }; baseToken?: { address?: string } }[] };
          const best = new Map<string, { usd: number; liquidity: number }>();
          for (const pair of body.pairs ?? []) {
            if (pair.chainId !== "base") continue;
            const tokenAddress = pair.baseToken?.address?.toLowerCase();
            const usd = Number(pair.priceUsd);
            const liquidity = Number(pair.liquidity?.usd ?? 0);
            if (!tokenAddress || !batch.includes(tokenAddress) || !Number.isFinite(usd) || usd <= 0) continue;
            const current = best.get(tokenAddress);
            if (!current || liquidity > current.liquidity) best.set(tokenAddress, { usd, liquidity });
          }
          for (const [tokenAddress, row] of best) next[tokenAddress] = row.usd;
        } catch { /* A missing price never invents a value or blocks selection. */ }
      }
      if (active) setPrices(next);
    })();
    return () => { active = false; };
  }, [tokens]);
  const addressSearch = search.trim().toLowerCase().startsWith("0x");
  const exact = isAddress(search.trim(), { strict: false });
  const query = search.trim().toLowerCase();
  const local = tokens.filter(t => (tab === "stocks" ? t.kind === "b20-tokenized-stock" : true) && (addressSearch ? t.address.toLowerCase() === query
    : [t.symbol, t.name].some(value => value.toLowerCase().includes(query))));
  const results = tab === "stocks" || addressSearch ? local : [...local, ...listedMatch(search, tokens)];
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
    const price = prices[isNativeEthSentinel(t.address) ? BASE_WETH.toLowerCase() : t.address.toLowerCase()];
    const usd = held && held.value > 0n && price ? Number(formatUnits(held.value, held.decimals)) * price : null;
    const blocked = !status.selectable;
    return <button key={t.address} type="button" disabled={blocked} title={status.message} onClick={() => onSelect(t)}
      className="flex min-h-[64px] w-full items-center gap-3 rounded-2xl px-3 py-2 text-left hover:bg-white/5 focus-visible:outline focus-visible:outline-emerald-300 disabled:cursor-not-allowed disabled:opacity-65"
      aria-label={`Select ${t.symbol} ${t.address}`}>
      <TokenIcon token={t} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2"><bdi className="truncate text-sm font-semibold">{t.symbol}</bdi>
          {!t.verified && <span className="shrink-0 text-[10px] text-amber-300">Unverified</span>}
          {chip && <span data-testid="token-route-unavailable" className={`text-[10px] ${chip.tone}`}>{chip.label}</span>}</span>
        <span className="block truncate text-xs text-zinc-400">{tokenName(t.name)}</span>
        <span className="block truncate font-mono text-[10px] text-zinc-500" title={t.address}>{isNativeEthSentinel(t.address) ? "Native Base asset" : shortAddress(t.address)}</span>
      </span>
      <span className="shrink-0 text-right">
        {usd !== null && Number.isFinite(usd) && usd > 0 && <span className="block text-sm text-white">{formatUsd(usd)}</span>}
        {held && <span className="block text-[11px] text-zinc-400">{formatAtomicAmount(held.value.toString(), held.decimals, 4)}</span>}
      </span>
      {selected.toLowerCase() === t.address.toLowerCase() && <Check size={18} className="shrink-0 text-emerald-300" />}
    </button>;
  };
  return <SwapDialog title="Select a token" onClose={onClose}>
    <label className="flex items-center gap-2 rounded-2xl border border-white/10 bg-black/15 px-3"><Search size={17} className="shrink-0 text-zinc-500" /><input autoFocus aria-label="Search tokens or Base contract" placeholder="Name, symbol or 0x…" value={search}
      className="min-h-12 min-w-0 flex-1 bg-transparent text-sm outline-none" maxLength={160}
      onChange={e => { run.current++; pending.current?.abort(); setBusy(false); setError(null); setImported(null); setHints([]); setSearched(false); setSearch(e.target.value); }} /></label>
    <div className="flex gap-2">
      {([["all", "All"], ["stocks", "Tokenized stocks"]] as const).map(([id, label]) => <button key={id} type="button" onClick={() => setTab(id)} className={`min-h-10 flex-1 rounded-xl text-sm ${tab === id ? "bg-white/10 text-white" : "text-zinc-400"}`}>{label}</button>)}
    </div>
    {addressSearch && !exact && <p role="alert" className="text-xs text-amber-300">Invalid address. Paste 0x and 40 hexadecimal characters.</p>}
    {!addressSearch && !results.length && <p className="py-5 text-sm text-zinc-400">No results. Paste an exact Base contract to validate a token.</p>}
    {addressSearch && exact && !imported && <div className="flex items-center gap-3 rounded-2xl border border-amber-300/15 bg-amber-300/5 p-3">
      <p className="min-w-0 flex-1 text-xs text-amber-100">This contract can be bought or sold when a route has liquidity. The 0.25% Trading Fee still applies.</p>
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
      const worth = (token: TradeTokenRef) => {
        const held = balances[token.address.toLowerCase()];
        const price = prices[isNativeEthSentinel(token.address) ? BASE_WETH.toLowerCase() : token.address.toLowerCase()];
        if (!held || held.value <= 0n || !price) return 0;
        const usd = Number(formatUnits(held.value, held.decimals)) * price;
        return Number.isFinite(usd) ? usd : 0;
      };
      const left = worth(a);
      const right = worth(b);
      if (left !== right) return right - left;
      return tokens.findIndex((token) => token.address.toLowerCase() === a.address.toLowerCase()) - tokens.findIndex((token) => token.address.toLowerCase() === b.address.toLowerCase());
    }).map(option)}{imported && tab === "all" && !results.some(t => t.address.toLowerCase() === imported.address.toLowerCase()) && option(imported)}</div>
    {(imported || results.some(t => !t.verified)) && <p className="rounded-xl bg-amber-300/5 p-3 text-xs text-amber-200">Import is not endorsement. A live quote still has to find liquidity, and every executed swap collects the 0.25% Trading Fee.</p>}
  </SwapDialog>;
}
