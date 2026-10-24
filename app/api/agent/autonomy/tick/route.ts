// app/api/agent/autonomy/tick/route.ts
//
// The scheduler entry point (spec §10). Reuses the EXISTING scheduling
// seams — no new worker, no setInterval:
//   * a live SIWE session triggers a wallet-scoped tick (the client
//     heartbeat while the app is open) — only after verifyTrustedOrigin,
//     because the session cookie is SameSite=None;
//   * Vercel Cron + CRON_SECRET (the repo's only server scheduler, same
//     pattern as the game settlement route) triggers a bounded all-wallet
//     pass.
//
// GET is what Vercel Cron invokes (Cron sends GET, not POST — see the
// settlement routes for the same convention). On GET the cron bearer token is
// MANDATORY: a cron call carries no session, and an unauthenticated GET must
// never trigger an all-wallet evaluation pass. POST keeps the original
// dual behaviour (cron OR a rate-limited session heartbeat).
//
// Every pass is bounded (per tick / per wallet limits in AUTONOMY_LIMITS),
// per-goal leases prevent duplicate evaluation across concurrent
// invocations, and the runtime refuses everything unless the feature flag
// is on — so an accidental or malicious hammering of this endpoint cannot
// trade, and with the flag on it still cannot execute without a delegation
// adapter + policy + a valid user-signed authorization slot.

import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

import { requestIdFromRequest, verifyTrustedOrigin, withRequestId } from "@/lib/api/request-guard";
import { checkRateLimit, clientIpFromRequest } from "@/lib/trade/trade-rate-limit";
import { authenticateRequest } from "@/lib/auth/session-store";
import { isAutonomousAgentEnabled } from "@/lib/autonomy/config";
import { bootstrapAutonomyPosture } from "@/lib/autonomy";
import { system } from "@/lib/autonomy/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The requested platform budget. It is NOT relied on: production showed the
// platform killing a tick at ~60 s despite maxDuration = 120, so raising this
// number is not a fix and it is deliberately left unchanged. Post-EXECUTING
// work is instead capped at AUTONOMY_EXECUTION_BUDGET_SECONDS (= 45 s after
// tick start), leaving 15 s before the observed 60 s kill for the Redis write
// that persists the real outcome. See lib/autonomy/config.ts.
export const maxDuration = 120;

const RATE_LIMIT = 6;
const RATE_WINDOW_MS = 60_000;

function isCronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(auth);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function runTick(request: Request, opts: { cronOnly: boolean }): Promise<Response> {
  // The time budget is anchored HERE, at invocation start, so auth and the
  // bootstrap RPCs below count against it.
  const tickStartedAt = new Date();
  const requestId = requestIdFromRequest(request);
  const json = (body: unknown, init?: ResponseInit) => withRequestId(NextResponse.json(body, init), requestId);

  if (!isAutonomousAgentEnabled()) {
    return json({ error: "Not available", code: "AUTONOMY_DISABLED" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  const cron = isCronAuthorized(request);
  let wallet: string | undefined;
  if (!cron) {
    // GET is the cron entry point: without a valid CRON_SECRET there is no
    // caller identity at all, so it is refused rather than falling back to a
    // session lookup (a browser GET could otherwise trigger an all-wallet pass).
    if (opts.cronOnly) {
      return json({ error: "Unauthorized", code: "CRON_AUTH_REQUIRED" }, { status: 401, headers: { "Cache-Control": "no-store" } });
    }
    // Session cookie is SameSite=None in production (Mini App webview).
    // A cross-site page can therefore POST this heartbeat and force a
    // wallet-scoped evaluation of already-authorized swaps. Cron keeps
    // working: it authenticates with CRON_SECRET and never reaches here.
    const originError = verifyTrustedOrigin(request);
    if (originError) return withRequestId(originError, requestId);
    const session = await authenticateRequest(request);
    if (!session) return json({ error: "Authentication required", code: "AUTH_REQUIRED" }, { status: 401, headers: { "Cache-Control": "no-store" } });
    const rate = await checkRateLimit(`${session.wallet.toLowerCase()}:autonomy-tick`, RATE_LIMIT, RATE_WINDOW_MS);
    if (!rate.allowed) {
      return json(
        { error: "Too many requests. Please slow down.", code: "RATE_LIMITED" },
        { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(rate.retryAfterSeconds) } },
      );
    }
    const ipRate = await checkRateLimit(`${clientIpFromRequest(request)}:autonomy-tick:ip`, RATE_LIMIT * 4, RATE_WINDOW_MS);
    if (!ipRate.allowed) {
      return json(
        { error: "Too many requests. Please slow down.", code: "RATE_LIMITED" },
        { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(ipRate.retryAfterSeconds) } },
      );
    }
    wallet = session.wallet.toLowerCase();
  }

  try {
    // MC-3 FIX: prove the delegated adapter's on-chain posture BEFORE
    // evaluating, so a cold instance's first tick is a real evaluation rather
    // than a park with ONCHAIN_CHECK_PENDING. Awaited (single-flight,
    // TTL-cached, a few read-only RPC calls, each bounded by DELEGATED_MAINNET_RPC_BOUNDS;
    // never throws and never enables execution by itself — a failed bootstrap
    // leaves the adapter refused exactly as before.
    await bootstrapAutonomyPosture();
    const summary = await system().scheduler.tick({ wallet, now: new Date(), tickStartedAt });
    // Bounded summary: goal ids are internal, expose only counts/kinds.
    return json(
      {
        ranAt: summary.ranAt,
        evaluated: summary.evaluated,
        scanned: summary.scanned,
        skippedBusy: summary.skippedBusy,
        outcomes: summary.results.slice(0, 20).map((r) => r.kind),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return json({ error: "Scheduler unavailable", code: "AUTONOMY_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

/** Vercel Cron entry point. Requires CRON_SECRET; no session fallback. */
export async function GET(request: Request) {
  return runTick(request, { cronOnly: true });
}

/** Client heartbeat (session-scoped) or an explicitly authorized cron call. */
export async function POST(request: Request) {
  return runTick(request, { cronOnly: false });
}
