"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useSwitchChain } from "wagmi";
import { ArrowDownUp, ChevronDown, Loader2, Settings2 } from "lucide-react";
import { formatUnits } from "viem";
import { MANUAL_SWAP_TOKENS, ManualSwapQuoteError, manualQuoteFresh, manualSwapInputError, type ManualSwapInput } from "@/lib/trade/manual-swap";
import { TRADE_DEFAULT_SLIPPAGE_BPS, isNativeEthSentinel } from "@/lib/trade/trade-config";
import { formatAtomicAmount, parseHumanTokenAmount } from "@/lib/trade/trade-format";
import { useSwapBalances, type SwapBalance } from "@/hooks/useSwapBalances";
import { requestSwapQuote } from "@/lib/swap/swap-quote";
import { estimateSwapGas } from "@/lib/swap/swap-wallet";
import { parseSlippagePercent, safeMaximum, slippagePercent } from "@/lib/swap/swap-policy";
import type { TradeProposal, TradeTokenRef } from "@/lib/trade/trade-types";
import { TokenIcon } from "./TokenIcon";
import { TokenSelector } from "./TokenSelector";
import { SlippageSettings } from "./SlippageSettings";
import { SwapDetails } from "./SwapDetails";
interface Props { authenticated: boolean; signIn: (options?: { force?: boolean }) => Promise<boolean>; onConnect: () => void; onReview: (proposal: TradeProposal) => void;
  balanceRevision: number; executionBusy: boolean; settledHash: string | null }
const SETTINGS_KEY = "mpgr:swap:8453:slippage";
export function SwapForm(props: Props) {
  const { address, chainId, isConnected } = useAccount();
  return <SwapPanel key={`${address}:${chainId}:${isConnected}`} {...props} />;
}
function SwapPanel({ authenticated, signIn, onConnect, onReview, balanceRevision, executionBusy, settledHash }: Props) {
  const { address, chainId, isConnected } = useAccount();
  const { switchChain } = useSwitchChain();
  const [input, setInput] = useState<ManualSwapInput>({ fromToken: MANUAL_SWAP_TOKENS.find(t => t.symbol === "USDC")!.address,
    toToken: MANUAL_SWAP_TOKENS.find(t => t.symbol === "WETH")!.address, amount: "", slippageBps: TRADE_DEFAULT_SLIPPAGE_BPS });
  const [imports, setImports] = useState<TradeTokenRef[]>([]);
  const tokens = useMemo(() => [...new Map([...MANUAL_SWAP_TOKENS, ...imports].map(t => [t.address.toLowerCase(), t])).values()], [imports]);
  const pay = tokens.find(t => t.address.toLowerCase() === input.fromToken.toLowerCase())!;
  const receive = tokens.find(t => t.address.toLowerCase() === input.toToken.toLowerCase())!;
  const balances = useSwapBalances(pay, receive, balanceRevision);
  const [select, setSelect] = useState<"fromToken" | "toToken" | null>(null);
  const [settings, setSettings] = useState(false);
  const [proposal, setProposal] = useState<TradeProposal | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const version = useRef(0); const pending = useRef<AbortController | null>(null);
  const busyRef = useRef(false); const lastAuto = useRef("");
  useEffect(() => () => { version.current++; pending.current?.abort(); }, []);
  useEffect(() => {
    try { const stored = sessionStorage.getItem(SETTINGS_KEY); if (stored) { const value = parseSlippagePercent(stored); if (value !== null) setInput(old => ({ ...old, slippageBps: value })); } } catch { /* storage unavailable: keep documented default */ }
  }, []);
  useEffect(() => { if (!proposal) return; const timer = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(timer); }, [proposal]);
  useEffect(() => {
    if (!settledHash) return;
    version.current++; pending.current?.abort(); busyRef.current = false;
    setProposal(null); setBusy(false); setInput(old => ({ ...old, amount: "" }));
  }, [settledHash]);
  const edit = useCallback((patch: Partial<ManualSwapInput>) => {
    version.current++; pending.current?.abort(); busyRef.current = false; lastAuto.current = "";
    setBusy(false); setProposal(null); setError(null); setNotice(null); setInput(current => ({ ...current, ...patch }));
  }, []);
  const authorize = useCallback(async (force = false) => {
    if (!isConnected || !address) { setSelect(null); onConnect(); return false; }
    if (chainId !== 8453) { setError("Switch to Base before importing or quoting a token."); return false; }
    if ((!authenticated || sessionExpired || force) && !(await signIn(sessionExpired || force ? { force: true } : undefined))) {
      setError("Wallet sign-in cancelled. No swap was submitted."); return false;
    }
    setSessionExpired(false); return true;
  }, [address, chainId, isConnected, authenticated, sessionExpired, signIn, onConnect]);
  const prepare = useCallback(async () => {
    if (busyRef.current || executionBusy) return;
    const invalid = manualSwapInputError(input, tokens);
    if (invalid) { setError(invalid); return; }
    const run = ++version.current; const controller = new AbortController(); pending.current = controller;
    busyRef.current = true; setBusy(true); setError(null); setProposal(null);
    try {
      if (!(await authorize()) || version.current !== run) return;
      const next = await requestSwapQuote(input, address!, controller.signal, tokens);
      if (version.current === run) { setNow(Date.now()); setProposal(next); }
    } catch (cause) {
      if (version.current === run) { if (cause instanceof ManualSwapQuoteError && cause.status === 401) setSessionExpired(true); setError(cause instanceof Error ? cause.message : "Quote unavailable. Retry."); }
    } finally { if (version.current === run) { setBusy(false); busyRef.current = false; } }
  }, [input, tokens, authorize, address, executionBusy]);
  const fingerprint = JSON.stringify(input);
  useEffect(() => {
    if (!authenticated || sessionExpired || !isConnected || chainId !== 8453 || executionBusy || manualSwapInputError(input, tokens)) return;
    if (lastAuto.current === fingerprint) return;
    const timer = setTimeout(() => { lastAuto.current = fingerprint; void prepare(); }, 700);
    return () => clearTimeout(timer);
  }, [fingerprint, authenticated, sessionExpired, isConnected, chainId, executionBusy, input, tokens, prepare]);
  const fresh = !!proposal && manualQuoteFresh(proposal, now);
  const parsedPay = balances.pay.state === "ready" ? parseHumanTokenAmount(input.amount, balances.pay.decimals) : null;
  const insufficient = balances.pay.state === "ready" && parsedPay !== null && parsedPay > balances.pay.value;
  const invalid = manualSwapInputError(input, tokens);
  const toggle = () => {
    const amount = fresh && proposal ? formatAtomicAmount(proposal.toAmount, proposal.to.decimals, proposal.to.decimals) : "";
    edit({ fromToken: input.toToken, toToken: input.fromToken, amount });
    setNotice(amount ? "Direction reversed. The previous estimated output is now the pay amount." : "Direction reversed. Enter a new pay amount.");
  };
  const max = async () => {
    if (balances.pay.state !== "ready" || busyRef.current || executionBusy) return;
    if (!isNativeEthSentinel(pay.address)) { edit({ amount: formatUnits(balances.pay.value, balances.pay.decimals) }); return; }
    const run = ++version.current; const controller = new AbortController(); pending.current = controller;
    busyRef.current = true; setBusy(true); setError(null);
    try {
      if (!(await authorize()) || version.current !== run) return;
      if (balances.pay.value <= 1n) throw new Error("Not enough ETH to reserve gas.");
      const candidate = await requestSwapQuote({ ...input, amount: formatUnits(balances.pay.value / 2n, balances.pay.decimals) }, address!, controller.signal, tokens);
      const gas = await estimateSwapGas(candidate);
      if (version.current !== run) return;
      const value = safeMaximum(balances.pay.value, true, gas);
      if (!value) throw new Error("Not enough ETH after the buffered network-fee reserve.");
      edit({ amount: formatUnits(value, balances.pay.decimals) });
      setNotice(`MAX reserves ${formatUnits(gas * 2n, 18)} ETH for estimated Base gas. Rechecked before signing; estimates can change.`);
    } catch (e) { if (version.current === run) setError(e instanceof Error ? e.message : "Could not estimate a safe native maximum. Enter a smaller amount."); }
    finally { if (version.current === run) { busyRef.current = false; setBusy(false); } }
  };
  const balanceText = (balance: SwapBalance) => balance.state === "ready" ? formatAtomicAmount(balance.value.toString(), balance.decimals, balance.decimals)
    : balance.state === "error" ? "Read unavailable" : balance.state === "wrong-network" ? "Switch to Base" : balance.state === "loading" ? "Loading…" : "Connect wallet";
  const panel = (side: "receive" | "pay") => {
    const isPay = side === "pay", token = isPay ? pay : receive, balance = isPay ? balances.pay : balances.receive;
    return <div className="min-w-0 space-y-3 rounded-[22px] border border-white/[0.04] bg-[#171e2a] p-4 sm:p-5" data-testid={`${side}-panel`}>
      <div className="flex items-center justify-between gap-2"><span className="text-xs text-zinc-400">{isPay ? "You pay" : "You receive"}</span>
        <span className="flex min-w-0 items-center gap-2 text-[11px] text-zinc-400"><span className="min-w-0 truncate" title={balanceText(balance)}>Balance: {balanceText(balance)}</span>
          {isPay && <button type="button" disabled={balance.state !== "ready" || busy || executionBusy} onClick={() => void max()} className="min-h-11 shrink-0 px-1 text-[11px] font-semibold text-emerald-300 disabled:opacity-40">MAX</button>}
          {balance.state === "error" && <button type="button" className="min-h-11 text-emerald-300" onClick={balances.refresh}>Retry balance</button>}
        </span></div>
      <div className="flex items-center gap-2">
        <input aria-label={isPay ? "You pay amount" : "You receive amount"} readOnly={!isPay} inputMode="decimal" autoComplete="off" maxLength={90}
          className={`min-h-14 min-w-0 w-full flex-1 bg-transparent text-[clamp(1.4rem,5vw,2rem)] font-medium tracking-tight outline-none placeholder:text-zinc-600 ${!isPay ? "text-zinc-200" : "text-white"}`}
          value={isPay ? input.amount : fresh && proposal ? formatAtomicAmount(proposal.toAmount, proposal.to.decimals, proposal.to.decimals) : ""} placeholder={isPay ? "0.00" : busy ? "Quoting…" : "—"}
          onChange={isPay ? e => edit({ amount: e.target.value }) : undefined} />
        <button type="button" aria-label={isPay ? `You pay token: ${token.symbol}` : `You receive token: ${token.symbol}`} onClick={() => setSelect(isPay ? "fromToken" : "toToken")}
          disabled={executionBusy} className="flex min-h-12 max-w-[52%] shrink-0 items-center gap-2 rounded-full border border-white/10 bg-[#232c3a] py-1.5 pl-1.5 pr-3 text-sm font-semibold hover:bg-[#2a3545] disabled:opacity-40">
          <TokenIcon token={token} /><bdi className="truncate">{token.symbol}</bdi><ChevronDown size={14} className="shrink-0 text-zinc-400" /></button>
      </div>
      {!token.verified && <p className="text-xs text-amber-300">Unverified token. Import is not endorsement; it may be unsafe or unsellable.</p>}
    </div>;
  };
  let rate = "";
  if (fresh && proposal) {
    const atomic = BigInt(proposal.toAmount) * 10n ** BigInt(proposal.from.decimals) / BigInt(proposal.fromAmount);
    const formatted = formatAtomicAmount(atomic.toString(), proposal.to.decimals, proposal.to.decimals);
    rate = `1 ${proposal.from.symbol} ≈ ${formatted} ${proposal.to.symbol}`;
  }
  return <form aria-label="Swap tokens" onSubmit={e => { e.preventDefault(); if (!isConnected) onConnect(); else if (chainId !== 8453) switchChain({ chainId: 8453 }); else if (fresh && proposal && !insufficient) onReview(proposal); else { lastAuto.current = fingerprint; void prepare(); } }} className="space-y-3">
    <div className="mb-1 flex items-center justify-between px-1"><span className="flex items-center gap-2 text-xs text-zinc-400"><span className="h-2 w-2 rounded-full bg-blue-500" />Base</span>
      <button type="button" aria-label="Slippage settings" onClick={() => setSettings(true)} className="flex min-h-11 items-center gap-2 rounded-full px-2 text-xs text-zinc-400 hover:bg-white/5"><span>{slippagePercent(input.slippageBps)}%</span><Settings2 size={17} /></button></div>
    {panel("receive")}
    <div className="relative z-[1] -my-6 flex h-0 justify-center"><button type="button" aria-label="Reverse swap direction" onClick={toggle} disabled={busy || executionBusy}
      className="relative -top-5 flex h-11 w-11 items-center justify-center rounded-2xl border-[5px] border-[#10151f] bg-[#253344] text-emerald-300 hover:bg-[#304257] disabled:opacity-40"><ArrowDownUp size={17} /></button></div>
    {panel("pay")}
    {notice && <p role="status" className="px-1 text-xs leading-relaxed text-zinc-400">{notice}</p>}
    {fresh && proposal && <div className="space-y-2 px-1 text-xs"><div className="flex flex-wrap justify-between gap-2"><span className="text-zinc-300">{rate}</span>
      <span className="text-zinc-400">Impact: {proposal.priceImpactBps == null ? "unavailable" : `${proposal.priceImpactBps / 100}%`}</span></div>
      {proposal.needsPermit2Approval && <p className="text-zinc-400">Token approval may be required for this pay amount. Approval is not a swap.</p>}
      <p className="text-zinc-400">{proposal.providerLabel} · MPGR 0.25% included in pay amount, not yet paid.</p>
      <p className="text-zinc-300">Minimum received: {formatAtomicAmount(proposal.minToAmount, proposal.to.decimals, proposal.to.decimals)} {proposal.to.symbol}</p>
      {proposal.risk.filter(r => r.severity !== "info" && !["executor-approval", "router-approval", "permit2-approval"].includes(r.id)).map(r => <p key={r.id} className="text-amber-200">{r.detail}</p>)}
    </div>}
    {input.slippageBps > 100 && <p className="px-1 text-xs text-amber-300">High slippage ({slippagePercent(input.slippageBps)}%). You accept a larger adverse price change.</p>}
    {proposal && !fresh && <p role="status" className="px-1 text-xs text-amber-300">Quote expired. Refresh before confirming; old output is not executable.</p>}
    {error && <p role="alert" className="break-words rounded-xl bg-red-300/5 p-3 text-xs leading-relaxed text-red-300">{error}</p>}
    {insufficient && <p role="alert" className="px-1 text-xs text-amber-300">Insufficient {pay.symbol} balance. Lower the pay amount.</p>}
    <button type="submit" disabled={busy || executionBusy || (isConnected && chainId === 8453 && (!!invalid || insufficient))}
      className="flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-emerald-300 px-4 text-base font-semibold text-[#071710] shadow-[0_6px_30px_-12px_rgba(110,231,183,0.4)] hover:bg-emerald-200 disabled:bg-white/[0.07] disabled:text-zinc-500 disabled:shadow-none">
      {busy && <Loader2 size={18} className="animate-spin" />}{!isConnected ? "Connect wallet" : chainId !== 8453 ? "Switch to Base" : busy ? "Fetching executable quote…" : insufficient ? "Insufficient balance" : invalid ? "Enter a pay amount" : sessionExpired ? "Sign in and retry quote" : fresh ? "Confirm Swap" : proposal ? "Refresh quote" : "Get quote"}
    </button>
    {fresh && proposal && <SwapDetails proposal={proposal} />}
    <p className="px-2 pt-1 text-center text-[11px] leading-relaxed text-zinc-500">Wallet-controlled. Approval is not a swap. Quotes are estimates; receipt verification establishes execution.</p>
    {select && <TokenSelector tokens={tokens} selected={input[select]} authorize={authorize} onClose={() => setSelect(null)} onSelect={token => {
      setImports(old => [...old.filter(t => t.address.toLowerCase() !== token.address.toLowerCase()), token]);
      const other = select === "fromToken" ? "toToken" : "fromToken";
      if (input[other].toLowerCase() === token.address.toLowerCase()) { edit({ fromToken: input.toToken, toToken: input.fromToken, amount: "" }); setNotice("Tokens reversed because the selection matched the other side. Enter a new pay amount."); }
      else edit({ [select]: token.address, ...(select === "fromToken" ? { amount: "" } : {}) });
      setSelect(null);
    }} />}
    {settings && <SlippageSettings bps={input.slippageBps} onClose={() => setSettings(false)} onApply={bps => {
      try { sessionStorage.setItem(SETTINGS_KEY, slippagePercent(bps)); } catch { /* selected in-memory value still retained */ }
      edit({ slippageBps: bps }); setSettings(false);
    }} />}
  </form>;
}
