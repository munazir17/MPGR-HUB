// lib/autonomy/scheduler.ts
//
// Scheduler / watcher (spec §10). Reuses the EXISTING scheduling seams:
//   * Vercel Cron + CRON_SECRET (the repo's only server scheduler —
//     app/api/games/mpgr-run/settlement) via the additive tick route;
//   * the client heartbeat (only while the app is open and goals exist).
// There is NO internal setInterval/worker and NO new scheduler process —
// `tick()` is the entire surface.
//
// tick() behavior:
//   * selects due goals (ACTIVE/WAITING, nextEvaluationAt <= now) bounded
//     by AUTONOMY_LIMITS (per tick, per wallet);
//   * per-goal leases (inside the runtime) prevent duplicate evaluation
//     across concurrent serverless invocations (duplicate prevention);
//   * bounded concurrency within one tick (maxConcurrentEvaluations);
//   * retry/backoff/expiry/pause/cancellation are goal STATE the runtime
//     already enforces — the scheduler adds no policy of its own.

import { AUTONOMY_LIMITS } from "./config";
import type { Logger, PerformanceMonitor } from "@/lib/architecture/core/types";
import type { AutonomyRuntime } from "./runtime";
import type { AutonomyStore } from "./store";

export interface TickSummary {
  ranAt: string;
  scanned: number;
  evaluated: number;
  skippedBusy: number;
  disabled: boolean;
  results: Array<{ goalId: string; kind: string }>;
}

const MAX_WALLETS_SCANNED = 200;

export class AutonomyScheduler {
  constructor(
    private readonly store: AutonomyStore,
    private readonly runtime: AutonomyRuntime,
    private readonly logger: Logger,
    private readonly performanceMonitor: PerformanceMonitor,
  ) {}

  /**
   * One bounded scheduling pass. `wallet` scopes the pass to a single
   * wallet (client heartbeat); omit it for the cron pass (all wallets).
   */
  async tick(options: { wallet?: string; now: Date }): Promise<TickSummary> {
    return this.performanceMonitor.time("autonomy.tick", async () => {
      const summary: TickSummary = {
        ranAt: options.now.toISOString(),
        scanned: 0,
        evaluated: 0,
        skippedBusy: 0,
        disabled: false,
        results: [],
      };

      const goalIds = await this.dueGoalIds(options.now, options.wallet);
      summary.scanned = goalIds.length;
      if (goalIds.length === 0) return summary;

      for (let i = 0; i < goalIds.length; i += AUTONOMY_LIMITS.maxConcurrentEvaluations) {
        const batch = goalIds.slice(i, i + AUTONOMY_LIMITS.maxConcurrentEvaluations);
        const outcomes = await Promise.all(batch.map((id) => this.runtime.evaluateGoal(id)));
        outcomes.forEach((outcome, idx) => {
          if (outcome.kind === "SKIPPED" && outcome.reason === "LEASE_BUSY") summary.skippedBusy += 1;
          if (outcome.kind === "SKIPPED" && outcome.reason === "DISABLED") summary.disabled = true;
          summary.results.push({ goalId: batch[idx], kind: outcome.kind });
          if (outcome.kind !== "SKIPPED") summary.evaluated += 1;
        });
      }
      this.logger.debug("Autonomy tick completed", {
        evaluated: summary.evaluated,
        skippedBusy: summary.skippedBusy,
        scanned: summary.scanned,
      });
      return summary;
    });
  }

  /**
   * Due-goal selection. Goals are read through the store's wallet index;
   * caps keep every tick bounded (no uncontrolled polling — a goal can be
   * evaluated at most once per cooldownSeconds, which has a 60s floor).
   */
  private async dueGoalIds(now: Date, wallet?: string): Promise<string[]> {
    const nowMs = now.getTime();
    const due: string[] = [];
    const wallets = wallet ? [wallet.toLowerCase()] : await this.store.listKnownWallets(MAX_WALLETS_SCANNED);

    for (const w of wallets) {
      if (due.length >= AUTONOMY_LIMITS.maxEvaluationsPerTick) break;
      const goals = await this.store.listGoals(w);
      const evaluatable = goals
        .filter((g) => g.status === "ACTIVE" || g.status === "WAITING" || (g.pendingExecution !== null && g.status === "EXECUTING"))
        // Verification passes on a pending execution are also gated by
        // nextEvaluationAt (verificationRetrySeconds) — an immediate
        // re-tick can never hammer the RPC for the same receipt.
        .filter((g) => new Date(g.nextEvaluationAt).getTime() <= nowMs)
        .sort((a, b) => a.nextEvaluationAt.localeCompare(b.nextEvaluationAt))
        .slice(0, AUTONOMY_LIMITS.maxEvaluationsPerWalletPerTick);
      for (const g of evaluatable) {
        if (due.length >= AUTONOMY_LIMITS.maxEvaluationsPerTick) break;
        due.push(g.id);
      }
    }
    return due;
  }
}
