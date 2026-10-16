"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAccount } from "wagmi";
import { MANUAL_SWAP_TOKENS, ManualSwapQuoteError, manualQuoteFresh, manualSwapInputError, requestManualSwapQuote, type ManualSwapInput } from "@/lib/trade/manual-swap";
import { TRADE_DEFAULT_SLIPPAGE_BPS } from "@/lib/trade/trade-config";
import type { TradeProposal } from "@/lib/trade/trade-types";

interface Props { authenticated: boolean; signIn: (options?: { force?: boolean }) => Promise<boolean>; onConnect: () => void; onReview: (proposal: TradeProposal) => void }
export function AgentManualSwapForm(props: Props) {
  const { address, chainId, isConnected } = useAccount();
  // Wallet/network switches unmount old pending requests and quote state.
  return <ManualSwapForm key={`${address}:${chainId}:${isConnected}`} {...props} />;
}
function ManualSwapForm({ authenticated, signIn, onConnect, onReview }: Props) {
  const { address, chainId, isConnected } = useAccount();
  const [input, setInput] = useState<ManualSwapInput>({ fromToken: MANUAL_SWAP_TOKENS.find(t => t.symbol === "USDC")!.address,
    toToken: MANUAL_SWAP_TOKENS.find(t => t.symbol === "WETH")!.address, amount: "", slippageBps: TRADE_DEFAULT_SLIPPAGE_BPS });
  const [proposal, setProposal] = useState<TradeProposal | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const version = useRef(0);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => { version.current++; pending.current?.abort(); }, []);
  useEffect(() => { if (!proposal) return; const timer = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(timer); }, [proposal]);
  const edit = (patch: Partial<ManualSwapInput>) => {
    version.current++; pending.current?.abort(); setBusy(false); setProposal(null); setError(null); setInput(current => ({ ...current, ...patch }));
  };
  const prepare = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setProposal(null); setError(null);
    if (!isConnected || !address) { onConnect(); return; }
    if (chainId !== 8453) { setError("Switch your wallet to Base Mainnet (8453) before preparing a swap."); return; }
    const invalid = manualSwapInputError(input);
    if (invalid) { setError(invalid); return; }
    const run = ++version.current;
    const controller = new AbortController(); pending.current = controller; setBusy(true);
    try {
      // Only explicit Prepare initiates the existing SIWE flow if necessary.
      if ((!authenticated || sessionExpired) && !(await signIn(sessionExpired ? { force: true } : undefined))) throw new Error("Wallet sign-in was not completed. No quote or transaction was submitted.");
      if (version.current !== run) return;
      setSessionExpired(false);
      const next = await requestManualSwapQuote(input, address, controller.signal);
      if (version.current === run) { setNow(Date.now()); setProposal(next); }
    } catch (cause) {
      if (version.current === run) {
        if (cause instanceof ManualSwapQuoteError && cause.status === 401) setSessionExpired(true);
        setError(cause instanceof Error ? cause.message : "Quote request failed. Try again.");
      }
    } finally { if (version.current === run) setBusy(false); }
  };
  const fresh = proposal && manualQuoteFresh(proposal, now);
  const field = "min-h-[44px] min-w-0 w-full rounded-lg border border-white/10 bg-surface-2 px-2 py-2 text-sm text-white";
  return <form onSubmit={prepare} className="space-y-3" aria-label="Prepare a manual swap">
    <div className="grid grid-cols-2 gap-2">
      {(["fromToken", "toToken"] as const).map((key) => <label key={key} className="min-w-0 text-xs text-muted">{key === "fromToken" ? "Sell token" : "Buy token"}
        <select aria-label={key === "fromToken" ? "Sell token" : "Buy token"} className={field} value={input[key]} onChange={e => edit({ [key]: e.target.value })}>
          {MANUAL_SWAP_TOKENS.map(t => <option key={t.address} value={t.address}>{t.symbol}</option>)}
        </select></label>)}
      <label className="min-w-0 text-xs text-muted">Sell amount<input className={field} inputMode="decimal" value={input.amount} onChange={e => edit({ amount: e.target.value })} placeholder="0.00" /></label>
      <label className="min-w-0 text-xs text-muted">Slippage (bps)<input className={field} inputMode="numeric" value={input.slippageBps} onChange={e => edit({ slippageBps: Number(e.target.value) })} /></label>
    </div>
    <p className="break-all text-[10px] text-muted">Base Mainnet · Sell: {input.fromToken} · Buy: {input.toToken}</p>
    <p className="text-xs text-muted">Token selection does not guarantee liquidity. Quotes come from the existing swap service. Review output, minimum, fees and approvals before confirming in your wallet. ETH and WETH are distinct assets.</p>
    <button className={field} type="submit" disabled={busy}>{busy ? "Preparing quote…" : sessionExpired ? "Sign in and retry quote" : proposal ? "Refresh quote" : !isConnected ? "Connect wallet to prepare" : "Prepare swap"}</button>
    {error && <p role="alert" className="break-words text-xs text-red-300">{error}</p>}
    {proposal && <div className="space-y-2 text-xs" aria-live="polite">
      <p>{fresh ? "Quote ready — not a settlement" : "Quote expired — refresh before review"}</p>
      {fresh && <p>{proposal.displayFromAmount} → {proposal.displayToAmount} · {proposal.providerLabel}</p>}
      <button className={field} type="button" disabled={!fresh || busy} onClick={() => {
        if (manualQuoteFresh(proposal)) onReview(proposal);
        else setNow(Date.now());
      }}>Review swap</button>
    </div>}
  </form>;
}
