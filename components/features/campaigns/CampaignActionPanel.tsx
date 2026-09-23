"use client";

// components/features/campaigns/CampaignActionPanel.tsx
//
// The participation panel on a campaign's detail page: join CTA, your
// standing (server-computed), and the configured earn actions. Every
// award is decided server-side — this panel only names the action and
// renders the result. Evidence-backed actions (e.g. verified MPGR Run
// sessions) are shown as automatically tracked, never as a manual form.

import { useState } from "react";
import { Zap } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { formatCompactNumber } from "@/lib/format";
import type { PublicCampaign } from "@/lib/campaigns/campaign-types";

interface CampaignActionPanelProps {
  campaign: PublicCampaign;
  busy: boolean;
  onJoin: () => Promise<{ ok: boolean; error?: string }>;
  onTrack: (
    actionId: string,
    options?: { eventId?: string; payload?: Record<string, unknown> },
  ) => Promise<{ ok: boolean; error?: string; pointsAwarded?: number; status?: string }>;
  /** Leader points for the progress bar (0 when unknown). */
  leaderPoints: number;
}

type Feedback = { kind: "success" | "error"; text: string } | null;
type PublicAction = PublicCampaign["points"]["actions"][number];

export function CampaignActionPanel({
  campaign,
  busy,
  onJoin,
  onTrack,
  leaderPoints,
}: CampaignActionPanelProps) {
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [numericValues, setNumericValues] = useState<Record<string, string>>({});

  const viewer = campaign.viewer;
  const joined = viewer?.joined ?? false;
  const isActive = campaign.status === "active";
  const progress =
    leaderPoints > 0 && viewer?.points !== undefined
      ? Math.min(100, Math.round((viewer.points / leaderPoints) * 100))
      : viewer?.points
        ? 100
        : 0;

  const handleJoin = async () => {
    setFeedback(null);
    const result = await onJoin();
    if (result.ok) {
      setFeedback({
        kind: "success",
        text:
          campaign.points.participation > 0
            ? `Joined! +${formatCompactNumber(campaign.points.participation)} participation points awarded.`
            : "Joined the campaign. Good luck!",
      });
    } else {
      setFeedback({ kind: "error", text: result.error ?? "Could not join the campaign." });
    }
  };

  const handleTrack = async (action: PublicAction) => {
    setFeedback(null);
    const options: { eventId?: string; payload?: Record<string, unknown> } = {};
    if (action.numericInput) {
      const raw = numericValues[action.id] ?? "";
      const parsed = Number(raw);
      if (!raw.trim() || !Number.isFinite(parsed)) {
        setFeedback({ kind: "error", text: `Enter a valid ${action.numericInput.label.toLowerCase()}.` });
        return;
      }
      options.payload = { [action.numericInput.field]: Math.trunc(parsed) };
    }
    const result = await onTrack(action.id, options);
    if (result.ok && result.status === "duplicate") {
      setFeedback({ kind: "success", text: "Already counted — no duplicate points are issued." });
    } else if (result.ok) {
      setFeedback({
        kind: "success",
        text: `Recorded! +${formatCompactNumber(result.pointsAwarded ?? action.points)} points.`,
      });
    } else {
      setFeedback({ kind: "error", text: result.error ?? "Could not record activity." });
    }
  };

  if (!isActive) {
    return (
      <GlassCard className="p-5">
        <p className="text-[12px] font-medium uppercase tracking-[0.14em] text-muted">
          {campaign.status === "completed" ? "Campaign ended" : "Campaign not active"}
        </p>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          {campaign.status === "completed"
            ? "This campaign is closed. The leaderboard below is the finalized result — rewards are distributed manually by the operator."
            : "Participation opens when the campaign becomes active."}
        </p>
        {viewer?.joined && (
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
              <p className="text-[11px] uppercase tracking-wide text-muted">Your points</p>
              <p className="font-mono text-lg font-semibold tabular-nums text-white">
                {formatCompactNumber(viewer.points)}
              </p>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
              <p className="text-[11px] uppercase tracking-wide text-muted">Your rank</p>
              <p className="font-mono text-lg font-semibold tabular-nums text-gold">
                {viewer.rank ? `#${viewer.rank}` : "—"}
              </p>
            </div>
          </div>
        )}
      </GlassCard>
    );
  }

  return (
    <GlassCard className="p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[12px] font-medium uppercase tracking-[0.14em] text-muted">
          {joined ? "Your standing" : "Join the campaign"}
        </p>
        {joined && viewer && (
          <span className="text-xs text-muted">
            {formatCompactNumber(viewer.points)} pts
            {viewer.rank ? ` · Rank #${viewer.rank}` : ""}
          </span>
        )}
      </div>

      {joined && viewer && (
        <div className="mt-3">
          <ProgressBar
            progress={progress}
            label={leaderPoints > 0 ? "Points vs. leaderboard leader" : "Campaign points"}
            variant="blue"
          />
        </div>
      )}

      {!joined ? (
        <>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            {campaign.eligibility?.description ??
              "Connect and sign in with your wallet to participate and appear on the leaderboard."}
            {campaign.points.participation > 0
              ? ` Earn ${formatCompactNumber(campaign.points.participation)} points just for joining.`
              : ""}
          </p>
          <button
            type="button"
            onClick={handleJoin}
            disabled={busy}
            className="btn-primary btn-primary-sm mt-4 w-full text-sm disabled:opacity-60"
          >
            <Zap className="h-4 w-4" aria-hidden="true" />
            {busy ? "Joining…" : "Join campaign"}
          </button>
        </>
      ) : (
        <div className="mt-4 space-y-2">
          {campaign.points.actions.map((action) => {
            const count = viewer?.completedActions?.[action.id] ?? 0;
            if (action.evidence) {
              return (
                <div
                  key={action.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-white">{action.label}</p>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-muted">
                      {action.description ?? "Tracked automatically from verified server activity."}
                    </p>
                  </div>
                  <span className="shrink-0 font-mono text-xs tabular-nums text-primary">
                    {count}×
                  </span>
                </div>
              );
            }
            return (
              <div
                key={action.id}
                className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-white">
                      {action.label}
                      <span className="ml-2 font-mono text-[11px] text-gold">
                        +{formatCompactNumber(action.points)} pts
                      </span>
                    </p>
                    {action.description && (
                      <p className="mt-0.5 text-[11px] leading-relaxed text-muted">{action.description}</p>
                    )}
                    {action.maxPerDay ? (
                      <p className="mt-0.5 text-[11px] text-muted/80">
                        {count}/{action.maxPerDay} today
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {action.numericInput && (
                      <input
                        type="number"
                        inputMode="numeric"
                        value={numericValues[action.id] ?? ""}
                        onChange={(event) =>
                          setNumericValues((prev) => ({ ...prev, [action.id]: event.target.value }))
                        }
                        placeholder={action.numericInput.label}
                        min={action.numericInput.min}
                        max={action.numericInput.max}
                        aria-label={action.numericInput.label}
                        className="w-32 rounded-lg border border-white/10 bg-background/60 px-2 py-1.5 text-xs text-white placeholder:text-muted/70 focus:border-primary/50 focus:outline-none"
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => handleTrack(action)}
                      disabled={busy}
                      className="btn-ghost px-3 py-1.5 text-xs disabled:opacity-60"
                    >
                      {busy ? "…" : "Record"}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {feedback && (
        <p
          role="status"
          className={`mt-4 text-xs leading-relaxed ${
            feedback.kind === "error" ? "text-bad" : "text-good"
          }`}
        >
          {feedback.text}
        </p>
      )}
    </GlassCard>
  );
}
