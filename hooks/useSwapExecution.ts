"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { getTransaction, getTransactionReceipt } from "wagmi/actions";
import { config } from "@/lib/wagmi";
import { executeTrade, idleTradeExecutionSnapshot, type TradeExecutionSnapshot } from "@/lib/trade/trade-execution";
import { swapQuoteNeedsRefresh } from "@/lib/swap/swap-lifecycle";
import { ManualSwapQuoteError } from "@/lib/trade/manual-swap";
import { revalidateTradeProposal } from "@/lib/trade/trade-confirmation";
import { requestSwapQuoteWithV2 } from "@/lib/swap/v2/v2-quote-client";
import { verifySwapV2SettlementRemote } from "@/lib/swap/v2/v2-settlement-client";
import { isSwapV2Proposal } from "@/lib/swap/v2/v2-target";
import { validateSwapWallet } from "@/lib/swap/swap-wallet";
import { swapQuotePolicyError, verifySwapSettlement, type SwapSettlement } from "@/lib/swap/swap-policy";
import { formatAtomicAmount } from "@/lib/trade/trade-format";
import type { TradeProposal } from "@/lib/trade/trade-types";
import type { Hash, TransactionReceipt } from "viem";
import { swapTransactionIdentityMatches, swapTransactionMatches } from "@/lib/swap/swap-transaction";
import { readSwapAllowance } from "@/lib/swap/swap-allowance";
export interface SwapActivity {
  id: string; proposal: TradeProposal; startedAt: number;
  approvalHash: Hash | null; swapHash: Hash | null;
  approvalStatus: "pending" | "confirmed" | "reverted" | "unknown" | null;
  swapStatus: "pending" | "confirmed" | "reverted" | "unverified" | null;
  proof: SwapSettlement | null;
}
export function useSwapExecution(onBalanceChange: () => void, signIn: (options?: { force?: boolean }) => Promise<boolean>) {
  const account = useAccount();
  const [proposal, setProposal] = useState<TradeProposal | null>(null);
  const [snapshot, setSnapshot] = useState(idleTradeExecutionSnapshot());
  const [proof, setProof] = useState<SwapSettlement | null>(null);
  // Honest session activity, not an invented indexed wallet history. No
  // browser cache can promote a transaction to confirmed/fee-collected.
  const [activities, setActivities] = useState<SwapActivity[]>([]);
  const [quoteUpdated, setQuoteUpdated] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [checking, setChecking] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const approvalReceipt = useRef<TransactionReceipt | undefined>(undefined);
  const active = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const session = useRef(0);
  const accountRef = useRef(account); accountRef.current = account;
  const refreshBalancesRef = useRef(onBalanceChange); refreshBalancesRef.current = onBalanceChange;
  const isBusy = ["REQUOTING", "APPROVING", "AWAITING_PERMIT", "AWAITING_WALLET", "PENDING"].includes(snapshot.state);
  const open = useCallback((p: TradeProposal) => {
    if (active.current) return;
    session.current++;
    approvalReceipt.current = undefined;
    setQuoteUpdated(false); setProposal(p); setProof(null); setSnapshot(idleTradeExecutionSnapshot());
  }, []);
  const close = useCallback(() => { if (!active.current) { session.current++; setProposal(null); } }, []);
  const refreshQuote = useCallback(async (p: TradeProposal) => {
    try {
      const next = await requestSwapQuoteWithV2({ fromToken: p.from.address, toToken: p.to.address,
        amount: formatAtomicAmount(p.fromAmount, p.from.decimals, p.from.decimals), slippageBps: p.slippageBps }, p.taker, undefined, [p.from, p.to], { fresh: true });
      setSessionExpired(false); return next;
    } catch (e) { if (e instanceof ManualSwapQuoteError && e.status === 401) setSessionExpired(true); throw e; }
  }, []);
  const retryQuote = useCallback(async () => {
    if (!proposal || active.current || snapshot.swapHash) return;
    const approval = activities.find(a => a.approvalHash === snapshot.approvalHash)?.approvalStatus;
    if (snapshot.approvalHash && (approval === "pending" || approval === "unknown")) return;
    if (accountRef.current.chainId !== 8453 || !accountRef.current.isConnected || accountRef.current.address?.toLowerCase() !== proposal.taker.toLowerCase()) {
      setSnapshot(s => ({ ...s, state: "ERROR", error: { code: "WALLET_REQUIRED", message: "Connect the quoted wallet on Base before refreshing." } })); return;
    }
    const run = session.current; active.current = true;
    setSnapshot(s => ({ ...s, state: "REQUOTING", error: null }));
    try {
      if (sessionExpired && !(await signIn({ force: true }))) throw new Error(`Wallet sign-in cancelled.${snapshot.approvalHash ? " Your existing approval is retained." : ""} No swap was submitted.`);
      if (!mounted.current || session.current !== run) return;
      const fresh = await refreshQuote(proposal);
      if (session.current === run) { setProposal(fresh); setQuoteUpdated(true); setSnapshot(s => ({ ...idleTradeExecutionSnapshot(), approvalHash: s.approvalHash })); }
    } catch (e) { if (session.current === run) setSnapshot(s => ({ ...s, state: "ERROR", error: { code: "PROVIDER_ERROR", message: e instanceof Error ? e.message : "Quote refresh failed." } })); }
    finally { active.current = false; }
  }, [proposal, snapshot.swapHash, snapshot.approvalHash, activities, refreshQuote, sessionExpired, signIn]);
  const confirm = useCallback(async () => {
    if (!proposal || active.current || snapshot.swapHash) return;
    const approval = activities.find(a => a.approvalHash === snapshot.approvalHash)?.approvalStatus;
    if (snapshot.approvalHash && (approval === "pending" || approval === "unknown")) return;
    if (accountRef.current.chainId !== 8453 || !accountRef.current.isConnected || accountRef.current.address?.toLowerCase() !== proposal.taker.toLowerCase()) {
      setSnapshot(s => ({ ...s, state: "ERROR", error: { code: "WALLET_REQUIRED", message: "Wallet or network changed. Switch to the quoted wallet on Base." } })); return;
    }
    // An expired/near-expiry quote is replaced for REVIEW, never for automatic
    // signing. The next explicit click accepts its new output and minimum.
    if (swapQuoteNeedsRefresh(proposal)) { await retryQuote(); return; }
    setQuoteUpdated(false);
    const validation = revalidateTradeProposal(proposal, accountRef.current.address);
    const invalid = swapQuotePolicyError(proposal);
    if (validation.state !== "VALIDATED" || invalid) {
      setSnapshot(s => ({ ...s, state: "ERROR", error: validation.error ?? { code: "EXECUTION_UNAVAILABLE", message: invalid! } })); return;
    }
    active.current = true; const run = session.current;
    let effective = proposal;
    let verified: SwapSettlement | null = null;
    const activityId = `${proposal.taker.toLowerCase()}:${proposal.id}:${Date.now()}`;
    let approvalStatus: SwapActivity["approvalStatus"] = null;
    let last: TradeExecutionSnapshot = idleTradeExecutionSnapshot();
    // Immediate visible lock, before any asynchronous read or wallet prompt.
    setSnapshot(s => ({ ...s, state: "REQUOTING", error: null, stepLabel: "Checking live swap details…" }));
    const update = (next: TradeExecutionSnapshot) => {
      last = next;
      if (session.current === run) setSnapshot(next);
      if (!next.approvalHash && !next.swapHash) return;
      const entry: SwapActivity = { id: activityId, proposal: effective, startedAt: Date.now(), approvalHash: next.approvalHash, swapHash: next.swapHash,
        approvalStatus: next.approvalHash ? approvalStatus ?? "pending" : null,
        swapStatus: !next.swapHash ? null : next.state === "SUCCESS" && verified?.verified ? "confirmed"
          : next.state === "ERROR" ? next.error?.code === "SEND_FAILED" ? "reverted" : "unverified" : "pending", proof: verified };
      setActivities(current => {
        const existing = current.find(a => a.id === activityId);
        return [{ ...entry, startedAt: existing?.startedAt ?? entry.startedAt }, ...current.filter(a => a.id !== activityId)].slice(0, 20);
      });
    };
    try {
      await executeTrade({ proposal, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: accountRef.current.address, currentChainId: accountRef.current.chainId,
        // Do not let the shared engine silently substitute a new quote. Its
        // expired-quote refusal is recovered below with an explicit review.
        safety: {
          beforeSignature: async (p, phase) => {
            if (!mounted.current || session.current !== run) return { code: "INVALID_INPUT", message: "Swap view closed. No further wallet request was initiated." };
            const invalid = await validateSwapWallet(p, phase, approvalReceipt.current);
            return !mounted.current || session.current !== run ? { code: "INVALID_INPUT", message: "Swap view closed. Request a new quote." } : invalid;
          },
          onEffectiveProposal: p => { effective = p; if (session.current === run) setProposal(p); },
          readAllowance: (p, receipt) => readSwapAllowance(p, receipt ?? approvalReceipt.current),
          onApprovalReceipt: (_hash, status, receipt) => {
            if (status === "success") approvalReceipt.current = receipt;
            approvalStatus = status === "success" ? "confirmed" : "reverted"; refreshBalancesRef.current();
          },
          verifySettlement: async (p, receipt) => {
            const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
            let indexed = false;
            let identityFailed = false;
            for (let attempt = 0; attempt < 5; attempt++) {
              if (attempt) await pause(350 * attempt);
              try {
                const tx = await getTransaction(config, { chainId: 8453, hash: receipt.transactionHash });
                if (swapTransactionMatches(p, receipt, tx)) { indexed = true; break; }
                if (!swapTransactionIdentityMatches(p, receipt, tx)) { identityFailed = true; break; }
              } catch { /* node has the receipt but not the transaction body yet */ }
            }
            if (!indexed) {
              return identityFailed
                ? { code: "PROVIDER_ERROR", message: "The mined transaction does not match the reviewed swap. Do not resubmit; inspect it on BaseScan." }
                : { code: "PROVIDER_ERROR", message: "Swap submitted. Its transaction details could not be verified yet. Check status; do not resubmit." };
            }
            // V2 receipts are verified server-side, which re-fetches the receipt
            // by hash and reads the executor's live fee posture at the MINED
            // block — stronger than anything the browser can assert locally.
            if (isSwapV2Proposal(p)) {
              let remote = await verifySwapV2SettlementRemote(receipt.transactionHash);
              for (let attempt = 0; attempt < 3 && remote.error && remote.error.code !== "SEND_FAILED"; attempt++) {
                await pause(600);
                remote = await verifySwapV2SettlementRemote(receipt.transactionHash);
              }
              verified = remote.settlement;
              if (session.current === run) setProof(verified);
              return remote.error ?? (verified.verified ? null : { code: "PROVIDER_ERROR", message: verified.reason! });
            }
            verified = verifySwapSettlement(p, receipt);
            if (session.current === run) setProof(verified);
            return verified.verified ? null : { code: "PROVIDER_ERROR", message: verified.reason! };
          },
        } }, update);
      if (last.error?.code === "QUOTE_EXPIRED" && !last.swapHash && mounted.current && session.current === run) {
        setSnapshot(s => ({ ...s, state: "REQUOTING", error: null, stepLabel: "Refreshing quote…" }));
        try {
          const fresh = await refreshQuote(effective);
          if (mounted.current && session.current === run) {
            setProposal(fresh); setQuoteUpdated(true);
            setSnapshot({ ...idleTradeExecutionSnapshot(), approvalHash: last.approvalHash });
          }
        } catch (e) {
          if (mounted.current && session.current === run) setSnapshot(s => ({ ...s, state: "ERROR", error: { code: "PROVIDER_ERROR", message: e instanceof Error ? e.message : "Quote refresh failed." } }));
        }
      }
    } finally {
      if (last.approvalHash && !last.swapHash && approvalStatus === null) setActivities(current => current.map(a => a.id === activityId ? { ...a, approvalStatus: "unknown" } : a));
      active.current = false; refreshBalancesRef.current();
    }
  }, [proposal, snapshot.swapHash, snapshot.approvalHash, activities, refreshQuote, retryQuote]);
  const checkHistory = useCallback(async () => {
    if (checking || active.current) return;
    const wallet = accountRef.current;
    if (!wallet.address || wallet.chainId !== 8453 || !wallet.isConnected) return;
    setChecking(true); setHistoryError(null);
    const historySession = session.current;
    let readFailed = false;
    try {
      const mine = activities.filter(a => a.proposal.taker.toLowerCase() === wallet.address!.toLowerCase());
      const updated = await Promise.all(mine.map(async a => {
        let next = { ...a };
        if (a.approvalHash) {
          try { const receipt = await getTransactionReceipt(config, { hash: a.approvalHash, chainId: 8453 });
            if (receipt.transactionHash.toLowerCase() === a.approvalHash.toLowerCase() && receipt.from.toLowerCase() === a.proposal.taker.toLowerCase() && receipt.to?.toLowerCase() === a.proposal.from.address.toLowerCase()) next.approvalStatus = receipt.status === "success" ? "confirmed" : "reverted";
            else next.approvalStatus = "unknown";
            // Carry the mined-block floor through manual receipt recovery too.
            // Never attach an old activity's checkpoint to a newly opened review.
            if (next.approvalStatus === "confirmed" && mounted.current && session.current === historySession && snapshot.approvalHash === a.approvalHash) approvalReceipt.current = receipt;
          } catch { readFailed = true; /* retain known evidence; RPC failure is not a revert */ }
        }
        if (a.swapHash) {
          try {
            const [receipt, tx] = await Promise.all([getTransactionReceipt(config, { hash: a.swapHash, chainId: 8453 }), getTransaction(config, { hash: a.swapHash, chainId: 8453 })]);
            const transactionMatches = swapTransactionMatches(a.proposal, receipt, tx);
            const result = transactionMatches ? verifySwapSettlement(a.proposal, receipt) : null;
            next = { ...next, swapStatus: !transactionMatches ? "unverified" : receipt.status === "reverted" ? "reverted" : result?.verified ? "confirmed" : "unverified", proof: result };
            // Closing/opening a review while this RPC was in flight must not
            // promote the NEW review with the previous swap's receipt.
            if (mounted.current && session.current === historySession && snapshot.swapHash === a.swapHash && result?.verified) {
              setProof(result); setSnapshot(s => s.swapHash === a.swapHash ? { ...s, state: "SUCCESS", error: null } : s);
            }
          } catch { readFailed = true; /* RPC unavailable/pending is not a revert */ }
        }
        return next;
      }));
      setActivities(current => current.map(a => updated.find(u => u.id === a.id) ?? a));
      refreshBalancesRef.current();
    } finally { setChecking(false); if (readFailed) setHistoryError("Some transaction receipts could not be refreshed. Status remains pending or previously verified; do not infer failure or resubmit."); }
  }, [activities, checking, snapshot.swapHash]);
  useEffect(() => {
    if (!activities.some(a => a.swapStatus === "pending" || a.swapStatus === "unverified" || a.approvalStatus === "pending")) return;
    const kick = setTimeout(() => { void checkHistory(); }, 400);
    const interval = setInterval(() => { void checkHistory(); }, 2_000);
    return () => { clearTimeout(kick); clearInterval(interval); };
  }, [activities, checkHistory]);
  return { proposal, snapshot, proof, isBusy, open, close, confirm, retryQuote, checking, sessionExpired, quoteUpdated, historyError, checkHistory,
    activities: account.isConnected && account.chainId === 8453 ? activities.filter(a => a.proposal.taker.toLowerCase() === account.address?.toLowerCase()) : [] };
}
