"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Loader2, Lock, CheckCircle2 } from "lucide-react";
import { GlassCard } from "./GlassCard";
import { ProgressBar } from "./ProgressBar";
import { REWARD_SOURCE_ICON } from "./reward-visuals";
import { REWARD_SOURCE_LABEL, type RewardClaim } from "@/lib/rewards-engine";

interface RewardClaimCardProps {
  reward: RewardClaim;
  onClaim: () => void;
  claiming?: boolean;
}

export function RewardClaimCard({ reward, onClaim, claiming = false }: RewardClaimCardProps) {
  const { title, description, amount, unlocked, claimed, progress, target, source } = reward;
  const pct = target === 0 ? 0 : Math.round((progress / target) * 100);
  const Icon = REWARD_SOURCE_ICON[source];
  const readyToClaim = unlocked && !claimed;

  // Fires a one-shot success burst the moment `claimed` flips from
  // false → true, without touching the claim logic itself.
  const [justClaimed, setJustClaimed] = useState(false);
  const wasClaimed = useRef(claimed);

  useEffect(() => {
    if (!wasClaimed.current && claimed) {
      setJustClaimed(true);
      const t = setTimeout(() => setJustClaimed(false), 1000);
      wasClaimed.current = claimed;
      return () => clearTimeout(t);
    }
    wasClaimed.current = claimed;
  }, [claimed]);

  return (
    <motion.div whileHover={{ y: -3 }} transition={{ type: "spring", stiffness: 300, damping: 22 }}>
      <GlassCard
        className={`relative overflow-hidden p-4 transition-opacity duration-300 ${
          unlocked || claimed ? "" : "opacity-60"
        } ${readyToClaim ? "ring-1 ring-gold/30" : ""}`}
      >
        {readyToClaim && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-8 -top-8 h-24 w-24 rounded-full bg-gradient-gold opacity-20 blur-2xl animate-glow-pulse"
          />
        )}

        <AnimatePresence>
          {justClaimed && (
            <motion.div
              aria-hidden="true"
              initial={{ opacity: 0.55, scale: 0.3 }}
              animate={{ opacity: 0, scale: 2.4 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.9, ease: "easeOut" }}
              className="pointer-events-none absolute inset-0 rounded-2xl bg-gradient-gold"
            />
          )}
        </AnimatePresence>

        <div className="relative flex items-start justify-between gap-2">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gold/10">
            <AnimatePresence mode="wait">
              {claimed ? (
                <motion.span
                  key="claimed"
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: "spring", stiffness: 400, damping: 15 }}
                >
                  <CheckCircle2 className="h-5 w-5 text-gold" aria-hidden="true" />
                </motion.span>
              ) : unlocked ? (
                <motion.span key="unlocked" initial={{ scale: 0 }} animate={{ scale: 1 }}>
                  <Icon className="h-5 w-5 text-gold" aria-hidden="true" />
                </motion.span>
              ) : (
                <Lock className="h-5 w-5 text-muted" aria-hidden="true" />
              )}
            </AnimatePresence>
          </div>
          <span className="flex flex-col items-end gap-1">
            <span className="rounded-full bg-gold/10 px-2 py-0.5 text-[10px] font-semibold text-gold">
              +{amount} MPGR
            </span>
            <span className="text-[9px] font-medium uppercase tracking-wider text-muted">
              {REWARD_SOURCE_LABEL[source]}
            </span>
          </span>
        </div>

        <p className="relative mt-3 text-sm font-semibold text-white">{title}</p>
        <p className="relative mt-1 text-xs leading-relaxed text-muted">{description}</p>

        <div className="relative mt-3">
          <ProgressBar progress={pct} />
          <p className="mt-1 text-[10px] text-muted">
            {progress}/{target}
          </p>
        </div>

        <button
          onClick={onClaim}
          disabled={!unlocked || claimed || claiming}
          aria-label={`${title} — ${claimed ? "claimed" : unlocked ? "claim reward" : "locked"}`}
          className="relative mt-3 flex min-h-[36px] w-full items-center justify-center gap-1.5 rounded-lg bg-gradient-gold py-1.5 text-xs font-semibold text-background transition-transform active:scale-95 disabled:cursor-not-allowed disabled:bg-none disabled:bg-surface disabled:text-muted"
        >
          {claiming ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Claiming
            </>
          ) : claimed ? (
            "Claimed"
          ) : unlocked ? (
            "Claim"
          ) : (
            "Locked"
          )}
        </button>
      </GlassCard>
    </motion.div>
  );
}
