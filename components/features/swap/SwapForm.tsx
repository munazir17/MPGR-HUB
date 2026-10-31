"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useSwitchChain } from "wagmi";
import { ArrowDownUp, ChevronDown, Loader2, Settings2 } from "lucide-react";
import { formatUnits } from "viem";
import { MANUAL_SWAP_TOKENS, ManualSwapQuoteError, type ManualSwapInput } from "@/lib/trade/manual-swap";
import { TRADE_DEFAULT_SLIPPAGE_BPS, NATIVE_ETH_SENTINEL, isNativeEthSentinel } from "@/lib/trade/trade-config";
import { parseHumanTokenAmount, readableTokenAmount } from "@/lib/trade/trade-format";
import { useSwapBalances, type SwapBalance } from "@/hooks/useSwapBalances";
import { swapQuoteFresh, swapQuoteNeedsRefresh, swapQuoteExpiry } from "@/lib/swap/swap-lifecycle";
import { formatSwapUsd, useTokenUsdPrice } from "@/hooks/useTokenUsdPrice";
import { swapInputError as manualSwapInputError } from "@/lib/swap/swap-capability";
import { requestSwapQuoteWithV2, fetchSwapV2Status } from "@/lib/swap/v2/v2-quote-client";
import { inspectSwapLiquidity } from "@/lib/swap/swap-inspection-client";
import { estimateSwapGas } from "@/lib/swap/swap-wallet";
import { parseSlippagePercent, safeMaximum, slippagePercent } from "@/lib/swap/swap-policy";
import { assessSwapRisk, RISK_DISCLAIMER, riskAckRequired } from "@/lib/swap/token-risk";
import type { TradeProposal, TradeTokenRef } from "@/lib/trade/trade-types";
import { TokenIcon, tokenName } from "./TokenIcon";
import { TokenSelector } from "./TokenSelector";
import { SlippageSettings } from "./SlippageSettings";
import { SwapDetails } from "./SwapDetails";
interface Props { authenticated: boolean; signIn: (options?: { force?: boolean }) => Promise<boolean>; onConnect: () => void; onReview: (proposal: TradeProposal) => void;
  balanceRevision: number; executionBusy: boolean; settledHash: string | null; reviewOpen: boolean }
const SETTINGS_KEY = "mpgr:swap:8453:slippage";
export function SwapForm(props: Props) {
  const { address, chainId, isConnected } = useAccount();
  return <SwapPanel key={`${address}:${chainId}:${isConnected}`} {...props} />;
}
function SwapPanel({ authenticated, signIn, onConnect, onReview, balanceRevision, executionBusy, settledHash, reviewOpen }: Props) {
  const { address, chainId, isConnected } = useAccount();
  const { switchChain } = useSwitchChain();
  const [input, setInput] = useState<ManualSwapInput>({ fromToken: MANUAL_SWAP_TOKENS.find(t => t.symbol === "USDC")!.address,
    toToken: NATIVE_ETH_SENTINEL, amount: "", slippageBps: TRADE_DEFAULT_SLIPPAGE_BPS });
  const [imports, setImports] = useState<TradeTokenRef[]>([]);
  const tokens = useMemo(() => [...new Map([...MANUAL_SWAP_TOKENS, ...imports].map(t => [t.address.toLowerCase(), t])).values()], [imports]);
  const pay = tokens.find(t => t.address.toLowerCase() === input.fromToken.toLowerCase())!;
  const receive = tokens.find(t => t.address.toLowerCase() === input.toToken.toLowerCase())!;
  const payUsd = useTokenUsdPrice(pay.address, pay.symbol);
  const receiveUsd = useTokenUsdPrice(receive.address, receive.symbol);
  const balances = useSwapBalances(pay, receive, balanceRevision);
  const [select, setSelect] = useState<"fromToken" | "toToken" | null>(null);
  const [settings, setSettings] = useState(false);
  const [proposal, setProposal] = useState<TradeProposal | null>(null);
  const [riskAcked, setRiskAcked] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  // BUY/SELL symmetry. While V2 routing is activated, probe the REVERSE direction
  // with the existing read-only liquidity inspection. That inspector only sees
  // getter-backed v2/v3 venues, so an empty result is NOT proof the token cannot
  // be sold — MPGR's pool is Uniswap v4 and would otherwise raise a false
  // "no reverse route" warning. A positive path can still clear the warning.
  // Unknown stays unknown. While V2 is dormant no probe runs at all.
  const [v2Activated, setV2Activated] = useState(false);
  // The probe result is stored WITH the pair it describes, and the value actually
  // used is derived during render. A result for a different pair is simply
  // ignored, so no synchronous setState is needed to "reset" it between quotes.
  const [sellSideProbe, setSellSideProbe] = useState<{ key: string; value: boolean | null } | null>(null);
  const sellSideKey = proposal ? `${proposal.from.address.toLowerCase()}->${proposal.to.address.toLowerCase()}:${proposal.id}` : "";
  const sellSideQuoted = sellSideProbe && sellSideProbe.key === sellSideKey ? sellSideProbe.value : null;
  useEffect(() => { let cancelled = false; void fetchSwapV2Status().then(s => { if (!cancelled) setV2Activated(s.activated); }).catch(() => {}); return () => { cancelled = true; }; }, []);
  useEffect(() => {
    if (!v2Activated || !proposal) return;
    const key = sellSideKey;
    const controller = new AbortController(); let cancelled = false;
    // setState only ever runs in the async callback, never in the effect body.
    inspectSwapLiquidity(proposal.to.address, proposal.from.address, controller.signal)
      .then(r => { if (!cancelled) setSellSideProbe({ key, value: !r.partial && r.paths.length > 0 ? true : null }); })
      .catch(() => { if (!cancelled) setSellSideProbe({ key, value: null }); });
    return () => { cancelled = true; controller.abort(); };
  }, [v2Activated, proposal, sellSideKey]);
  const riskWarnings = useMemo(() => (proposal ? assessSwapRisk({ chainId: 8453, receiveAddress: receive.address, receiveVerified: receive.verified, receiveImported: !receive.verified, priceImpactBps: proposal.priceImpactBps ?? null, sellSideQuoted }) : []), [proposal, receive, sellSideQuoted]);
  const riskAckNeeded = riskAckRequired(riskWarnings);
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
  const prepare = useCallback(async (freshReview = false, keepVisible = false) => {
    if (busyRef.current || executionBusy) return;
    const invalid = manualSwapInputError(input, tokens);
    if (invalid) { setError(invalid); return; }
    const run = ++version.current; const controller = new AbortController(); pending.current = controller;
    busyRef.current = true; setBusy(true); setError(null); if (!keepVisible) setProposal(null);
    try {
      if (!(await authorize()) || version.current !== run) return;
      const next = await requestSwapQuoteWithV2(input, address!, controller.signal, tokens, { fresh: freshReview });
      if (version.current === run) { setNow(Date.now()); setProposal(next); setRiskAcked(false); if (freshReview) setNotice("Quote updated — review new output."); }
    } catch (cause) {
      if (version.current === run) { if (cause instanceof ManualSwapQuoteError && cause.status === 401) setSessionExpired(true); setError(cause instanceof Error ? cause.message : "Quote unavailable. Retry."); }
    } finally { if (version.current === run) { setBusy(false); busyRef.current = false; } }
  }, [input, tokens, authorize, address, executionBusy]);
  const fingerprint = JSON.stringify(input);
  useEffect(() => {
    if (!authenticated || sessionExpired || !isConnected || chainId !== 8453 || executionBusy || manualSwapInputError(input, tokens)) return;
    if (lastAuto.current === fingerprint) return;
    const timer = setTimeout(() => { lastAuto.current = fingerprint; void prepare(); }, 150);
    return () => clearTimeout(timer);
  }, [fingerprint, authenticated, sessionExpired, isConnected, chainId, executionBusy, input, tokens, prepare]);
  useEffect(() => {
    if (!proposal || reviewOpen || !swapQuoteFresh(proposal)) return;
    const delay = Math.max(1_000, swapQuoteExpiry(proposal) - Date.now() - 20_000);
    const timer = setTimeout(() => { void prepare(true, true); }, delay);
    return () => clearTimeout(timer);
  }, [proposal, reviewOpen, prepare]);
  const fresh = !!proposal && swapQuoteFresh(proposal, now);
  const extremeImpact = fresh && proposal != null && proposal.priceImpactBps != null && proposal.priceImpactBps >= 5000;
  const parsedPay = balances.pay.state === "ready" ? parseHumanTokenAmount(input.amount, balances.pay.decimals) : null;
  const insufficient = balances.pay.state === "ready" && parsedPay !== null && parsedPay > balances.pay.value;
  const invalid = manualSwapInputError(input, tokens);
  const toggle = () => {
    const amount = proposal && swapQuoteFresh(proposal) ? readableTokenAmount(proposal.toAmount, proposal.to.decimals, 6) : "";
    edit({ fromToken: input.toToken, toToken: input.fromToken, amount });
  };
  const max = async () => {
    if (balances.pay.state !== "ready" || busyRef.current || executionBusy) return;
    if (!isNativeEthSentinel(pay.address)) {
      if (balances.pay.value < 400n) { setError("Balance is too small for a nonzero required fee. MAX was not applied."); return; }
      edit({ amount: readableTokenAmount(balances.pay.value.toString(), balances.pay.decimals, 6) }); return;
    }
    const run = ++version.current; const controller = new AbortController(); pending.current = controller;
    busyRef.current = true; setBusy(true); setError(null);
    try {
      if (!(await authorize()) || version.current !== run) return;
      if (balances.pay.value <= 1n) throw new Error("Not enough ETH to reserve gas.");
      const candidate = await requestSwapQuoteWithV2({ ...input, amount: formatUnits(balances.pay.value / 2n, balances.pay.decimals) }, address!, controller.signal, tokens);
      const gas = await estimateSwapGas(candidate);
      if (version.current !== run) return;
      const value = safeMaximum(balances.pay.value, true, gas);
      if (!value || value < 400n) throw new Error("Not enough ETH after the buffered network-fee reserve.");
      edit({ amount: readableTokenAmount(value.toString(), balances.pay.decimals, 6) });
      setNotice(`MAX reserves ${formatUnits(gas * 2n, 18)} ETH for estimated Base gas. Rechecked before signing; estimates can change.`);
    } catch (e) { if (version.current === run) setError(e instanceof Error ? e.message : "Could not estimate a safe native maximum. Enter a smaller amount."); }
    finally { if (version.current === run) { busyRef.current = false; setBusy(false); } }
  };
  const fillPercent = async (percent: 25 | 50 | 75 | 100) => {
    if (balances.pay.state !== "ready" || busyRef.current || executionBusy) return;
    if (isNativeEthSentinel(pay.address) && percent === 100) {
      await max();
      return;
    }
    const value = (balances.pay.value * BigInt(percent)) / 100n;
    if (value < 400n) {
      setError("That share of the balance is too small. Choose a larger percent or enter an amount.");
      return;
    }
    edit({ amount: readableTokenAmount(value.toString(), balances.pay.decimals, 6) });
  };
  const balanceText = (balance: SwapBalance) => balance.state === "ready" ? readableTokenAmount(balance.value.toString(), balance.decimals, 6)
    : balance.state === "error" ? "Read unavailable" : balance.state === "wrong-network" ? "Switch to Base" : balance.state === "loading" ? "Loading…" : "Connect wallet";
  const panel = (side: "receive" | "pay") => {
    const isPay = side === "pay", token = isPay ? pay : receive, balance = isPay ? balances.pay : balances.receive;
    const amountValue = isPay ? input.amount : fresh && proposal ? readableTokenAmount(proposal.toAmount, proposal.to.decimals, 6) : "";
    const expanded = amountValue.length > 8;
    return <div className="min-w-0 space-y-2 rounded-[22px] border border-white/[0.04] bg-[#171e2a] p-3 sm:p-4" data-testid={`${side}-panel`}>
      <div className="flex items-center justify-between gap-2"><span className="text-xs text-zinc-400">{isPay ? "You pay" : "You receive"}</span>
        <span className="flex min-w-0 items-center gap-2 text-[11px] text-zinc-400"><span className="min-w-0 truncate" title={balanceText(balance)}>Balance: {balanceText(balance)}</span>
          {balance.state === "error" && <button type="button" className="min-h-11 text-emerald-300" onClick={balances.refresh}>Retry balance</button>}
        </span></div>
      {isPay && <div className="grid grid-cols-4 gap-1.5" role="group" aria-label="Pay amount from balance">
        {([25, 50, 75, 100] as const).map((percent) => (
          <button key={percent} type="button" aria-label={percent === 100 ? "MAX" : `${percent}%`}
            disabled={balance.state !== "ready" || (balance.state === "ready" && balance.value < 400n) || busy || executionBusy}
            onClick={() => void fillPercent(percent)}
            className="h-8 rounded-lg border border-white/10 bg-white/[0.03] text-[11px] font-semibold text-emerald-300 hover:bg-white/[0.06] disabled:opacity-40">
            {percent}%
          </button>
        ))}
      </div>}
      <div className={`flex items-center gap-2 ${expanded ? "flex-wrap" : ""}`}>
        {/* Recreate the native edit control after modal focus restoration; its exact value stays in React state. */}
        <textarea key={`${side}:${reviewOpen}`} rows={expanded ? Math.ceil(amountValue.length / 24) : 1} wrap="soft" aria-label={isPay ? "You pay amount" : "You receive amount"} readOnly={!isPay} inputMode="decimal" autoComplete="off" maxLength={90}
          className={`min-h-12 min-w-0 w-full flex-1 resize-none overflow-hidden bg-transparent text-[clamp(1rem,4.8vw,1.85rem)] font-medium tracking-tight outline-none focus:outline-none focus-visible:outline-none placeholder:text-zinc-600 ${expanded ? "basis-full" : ""} ${!isPay ? "text-zinc-200" : "text-white"}`}
          style={{ lineHeight: "1.3", outline: "none", fontSize: `${Math.max(0.85, 1.85 - Math.max(0, amountValue.length - 8) * 0.045)}rem` }}
          value={amountValue} placeholder={isPay ? "0.00" : busy ? "Quoting…" : "—"}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); if (isPay) e.currentTarget.form?.requestSubmit(); } }}
          onChange={isPay ? e => edit({ amount: e.target.value }) : undefined} />
        <button type="button" aria-label={isPay ? `You pay token: ${token.symbol}` : `You receive token: ${token.symbol}`} title={`${tokenName(token.name)} · Base 8453 · ${isNativeEthSentinel(token.address) ? "Native asset (not an ERC-20 contract)" : token.address}`} onClick={() => setSelect(isPay ? "fromToken" : "toToken")}
          disabled={executionBusy} className="ml-auto flex min-h-12 max-w-[52%] shrink-0 items-center gap-2 rounded-full border border-white/10 bg-[#232c3a] py-1.5 pl-1.5 pr-3 text-sm font-semibold hover:bg-[#2a3545] disabled:opacity-40">
          <TokenIcon token={token} /><bdi className="truncate">{token.symbol}</bdi><ChevronDown size={14} className="shrink-0 text-zinc-400" /></button>
      </div>
      <p className="truncate text-[11px] text-zinc-400" title={tokenName(token.name)}>{tokenName(token.name)}{isNativeEthSentinel(token.address) ? " · Native Base asset" : ""}</p>
      {formatSwapUsd(amountValue, isPay ? payUsd : receiveUsd) && (
        <p className="text-xs font-medium text-zinc-300" data-testid={`${side}-usd`}>{formatSwapUsd(amountValue, isPay ? payUsd : receiveUsd)}</p>
      )}
      {!token.verified && <p className="text-xs text-amber-300">Unverified token. Import is not endorsement; it may be unsafe or unsellable.<span className="mt-1 block break-all font-mono text-[10px]">{token.address}</span></p>}
    </div>;
  };
  // V2 route evidence stays on the proposal. The swap screen does not print it.
  let rate = "";
  if (fresh && proposal) {
    const atomic = BigInt(proposal.toAmount) * 10n ** BigInt(proposal.from.decimals) / BigInt(proposal.fromAmount);
    const formatted = readableTokenAmount(atomic.toString(), proposal.to.decimals, 8);
    rate = `1 ${proposal.from.symbol} ≈ ${formatted} ${proposal.to.symbol}`;
  }
  return <form aria-label="Swap tokens" onSubmit={e => { e.preventDefault(); if (!isConnected) onConnect(); else if (chainId !== 8453) switchChain({ chainId: 8453 }); else if (proposal && swapQuoteFresh(proposal) && !swapQuoteNeedsRefresh(proposal) && !insufficient && !busyRef.current && !executionBusy) onReview(proposal); else { lastAuto.current = fingerprint; void prepare(!!proposal || !!error); } }} className="space-y-3">
    <div className="mb-1 flex items-center justify-between px-1"><span className="flex items-center gap-2 text-xs text-zinc-400"><span className="h-2 w-2 rounded-full bg-blue-500" />Base</span>
      <button type="button" aria-label="Slippage settings" onClick={() => setSettings(true)} className="flex min-h-11 items-center gap-2 rounded-full px-2 text-xs text-zinc-400 hover:bg-white/5"><span>{slippagePercent(input.slippageBps)}%</span><Settings2 size={17} /></button></div>
    {panel("pay")}
    <div className="relative z-[1] -my-6 flex h-0 justify-center"><button type="button" aria-label="Reverse swap direction" onClick={toggle} disabled={busy || executionBusy}
      className="relative -top-5 flex h-11 w-11 items-center justify-center rounded-2xl border-[5px] border-[#10151f] bg-[#253344] text-emerald-300 hover:bg-[#304257] disabled:opacity-40"><ArrowDownUp size={17} /></button></div>
    {panel("receive")}
    {notice && <p role="status" className="px-1 text-xs leading-relaxed text-zinc-400">{notice}</p>}
    {fresh && proposal && <div className="space-y-2 px-1 text-xs"><div className="flex flex-wrap justify-between gap-2"><span className="text-zinc-300">{rate}</span>
      <span className="text-zinc-400">Impact: {proposal.priceImpactBps == null ? "unavailable" : `${(proposal.priceImpactBps / 100).toFixed(2)}%`}</span></div>
      {/[23]-hop/.test(proposal.providerLabel) && <p className="text-zinc-400">Routed through a liquid pool. The 0.25% Trading Fee is still taken in this swap.</p>}
      {proposal.provider === "public-router" && <p className="text-zinc-300">This route cannot collect the 0.25% Trading Fee, so it is not available.</p>}
      {proposal.needsPermit2Approval && <p className="text-zinc-400">Token approval may be required for this pay amount. Approval is not a swap.</p>}
      <p className="text-zinc-300">Minimum received: {readableTokenAmount(proposal.minToAmount, proposal.to.decimals, 6)} {proposal.to.symbol}</p>
      {proposal.risk.filter(r => r.severity !== "info" && !["executor-approval", "router-approval", "permit2-approval"].includes(r.id)).map(r => <p key={r.id} className="text-amber-200">{r.detail}</p>)}
    </div>}
    {input.slippageBps > 100 && <p className="px-1 text-xs text-amber-300">High slippage ({slippagePercent(input.slippageBps)}%). You accept a larger adverse price change.</p>}
    {fresh && proposal && riskWarnings.length > 0 && <div data-testid="swap-risk-warnings" className="space-y-1 rounded-2xl border border-amber-300/30 bg-amber-300/5 px-3 py-2">
      {riskWarnings.map(w => <p key={w.code} data-testid="swap-risk-warning" className="text-xs leading-relaxed text-amber-200">{w.message}</p>)}
      <p className="text-xs leading-relaxed text-zinc-400">{RISK_DISCLAIMER}</p>
      {riskAckNeeded && <label className="flex items-start gap-2 text-xs text-zinc-200">
        <input data-testid="swap-risk-ack" type="checkbox" checked={riskAcked} onChange={e => setRiskAcked(e.target.checked)} className="mt-0.5 h-4 w-4 accent-amber-300" />
        I understand these risks and still want to continue.
      </label>}
    </div>}
    {proposal && !fresh && <p role="status" className="px-1 text-xs text-amber-300">Quote needs updating.</p>}
    {insufficient && <p role="alert" className="px-1 text-xs text-amber-300">Insufficient {pay.symbol} balance. Lower the pay amount.</p>}
    <button type="submit" disabled={busy || executionBusy || extremeImpact || (riskAckNeeded && !riskAcked) || (isConnected && chainId === 8453 && (!!invalid || insufficient))}
      className="flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-emerald-300 px-4 text-base font-semibold text-[#071710] shadow-[0_6px_30px_-12px_rgba(110,231,183,0.4)] hover:bg-emerald-200 disabled:bg-white/[0.07] disabled:text-zinc-500 disabled:shadow-none">
      {busy && <Loader2 size={18} className="animate-spin" />}{!isConnected ? "Connect wallet" : chainId !== 8453 ? "Switch to Base" : busy ? "Refreshing quote…" : extremeImpact ? "Price impact too high — lower the amount" : insufficient ? "Insufficient balance" : invalid ? "Enter a pay amount" : sessionExpired ? "Sign in and retry quote" : fresh ? "Confirm Swap" : proposal ? "Refresh quote" : "Get quote"}
    </button>
    {!reviewOpen && (proposal || error) && <SwapDetails proposal={fresh ? proposal : null} issue={error} payToken={pay} />}
    {select && <TokenSelector tokens={tokens} opposite={select === "fromToken" ? receive : pay} selectingPay={select === "fromToken"} onImport={token => setImports(old => [...old.filter(t => t.address.toLowerCase() !== token.address.toLowerCase()), token])} selected={input[select]} authorize={authorize} onClose={() => setSelect(null)} onSelect={token => {
      setImports(old => [...old.filter(t => t.address.toLowerCase() !== token.address.toLowerCase()), token]);
      const other = select === "fromToken" ? "toToken" : "fromToken";
      if (input[other].toLowerCase() === token.address.toLowerCase()) { setNotice("Choose two different tokens. Your pay token and amount are unchanged."); }
      else edit({ [select]: token.address, ...(select === "fromToken" ? { amount: "" } : {}) });
      setSelect(null);
    }} />}
    {settings && <SlippageSettings bps={input.slippageBps} onClose={() => setSettings(false)} onApply={bps => {
      try { sessionStorage.setItem(SETTINGS_KEY, slippagePercent(bps)); } catch { /* selected in-memory value still retained */ }
      edit({ slippageBps: bps }); setSettings(false);
    }} />}
  </form>;
}
