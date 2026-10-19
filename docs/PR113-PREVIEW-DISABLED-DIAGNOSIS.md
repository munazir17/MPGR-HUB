# PR #113 — Preview authorization disabled-state follow-up

Date: 2026-10-16. Baseline: `c004a143797e15705f3d8a0fa22883215403fc78`.
Implementation/test commit: `6e49ac6cd62d6b0b3f420e686bb5e11a86fa84dd`.
Existing branch: `arena/b8c82200-mpgr-hub`; no merge.

## Exact source and what is / is not established

The runtime-disabled value comes from **`process.env.MPGR_AUTONOMOUS_AGENT_ENABLED` in the deployed server environment**:

1. `lib/autonomy/config.ts` → `envFlag()` / `isAutonomousAgentEnabled()`: only trimmed, case-insensitive `true` enables the runtime.
2. `lib/autonomy/index.ts` → `autonomyStatus().enabled` reads that function. It is not derived from quote success, model settings, a client `NEXT_PUBLIC_*` variable, wallet sign-in, or the production flag.
3. `app/api/agent/autonomy/config/route.ts`: dynamic, no-store public GET returns the status. Its `X-MPGR-Autonomy-Runtime-Gate` header independently classifies that same environment variable through `publicGateState()`.
4. `lib/api/autonomy-settings.ts` → `readAutonomySettings()` → `useAgentAutonomy` stores validated config and diagnostics. `enabled=false` is a **successfully loaded disabled configuration**, not a fetch/schema failure.
5. `chatReviewAuthorizationError()` checks runtime before production readiness; therefore runtime-off is the first disabled-button reason when both gates are closed.

The exact-head reference check for baseline `c004a14`, observed **2026-10-16T17:56:25.881Z**, reports settings **HTTP 200**, valid/no-store; `enabled=false`, `runtimeFlag=disabled`, `productionGate=false`, `productionFlag=missing`, `executionAvailable=false`, delegated chain null. Tokens/goals/policy/authorization return **404 `AUTONOMY_DISABLED`**. [Read-only reference check](https://github.com/munazir17/MPGR-HUB/actions/runs/38943300480/job/117116048982).

**`disabled` proves an explicit effective value normalizing to `false`**, not missing/empty/invalid. `.env.example:170–176` and the rollout contract at the top of `lib/autonomy/config.ts` deliberately document default-off behavior; `docs/AUTONOMY.md` assigns enablement to an operator. `.env.example` is only a template, **not proof of how Vercel obtained its value**. Tracked `vercel.json` and `next.config.mjs` do not supply this flag.

The user's verified Vercel finding establishes the `mpgr-hub-ezxs` Preview was READY at this exact baseline SHA, and that `AUTONOMOUS_PRODUCTION_ENABLED` is scoped to Production only. Its absence from Preview is consistent with the observed `productionFlag=missing`; **that scope remains unchanged**.

### Operator-intent boundary — still unverified

The default-off safety design is intentional. However, **who set the effective Preview runtime value, its exact Vercel team/shared/project/branch-specific environment row, and whether that Preview override was intentional cannot be established from the public status or repository**. Arena's Vercel connector lookup returned unsupported; no direct Vercel environment/audit access is available. No intent or environment-row provenance is invented.

The remaining read-only operator check is: Vercel → `mpgr-hub-ezxs` → Settings → Environment Variables → `MPGR_AUTONOMOUS_AGENT_ENABLED`; inspect Preview targets, any override for `arena/b8c82200-mpgr-hub`, shared/team inheritance, the exact deployment's effective environment and audit author/time. **Inspect only; do not edit values/scopes or copy the Production gate into Preview.** No passwords/tokens or secret values are needed in chat.

## Message and diagnostic change

For the verified closed-gate Preview posture, the message is now:

> Autonomous runtime is not enabled (runtime flag: disabled; production flag: missing). Mainnet autonomous authorization is unavailable in Preview. Use Manual mode for user-confirmed swaps. Retrying or signing in cannot enable these gates. No goal was created.

The production-only blocker likewise directs users to Manual. Settings failures retain their separate HTTP/schema/network diagnostics; wrong-network, stale-quote and adapter failures retain their specific guards.

To identify Preview truthfully rather than guessing from hostname or labelling Production as Preview, the config GET adds **only** `X-MPGR-Autonomy-Deployment-Environment`, a whitelist classification of the platform's `VERCEL_ENV`: `preview`, `production`, `development`, or `unknown`. No arbitrary environment labels/values are exposed. The body schema is unchanged; old/absent headers fall back to generic “on this deployment.” The environment is also shown in the existing collapsed diagnostics.

**This field is diagnostic only.** It does not open a gate, override config booleans, assert readiness, or categorically block an otherwise fully ready isolated fixture. Existing runtime/production/emergency/adapter/token/wallet/session/form/quote checks and server admission guards remain authoritative. The existing GET-only reference workflow now includes this whitelisted classification in its safe exact-head annotation; triggers, permissions, environment values, endpoint allowlist and production-off assertion are unchanged. No workflow was manually dispatched.

## Changed files

| File(s) | Purpose |
|---|---|
| `app/api/agent/autonomy/config/route.ts` | Add the classified deployment-context response header; no change to gate computation/body/read-only behavior. |
| `lib/api/autonomy-settings.ts` | Whitelist/parse optional deployment context with unknown fallback. |
| `components/features/agent/chat-autonomy-review.ts` | Accurate Preview/runtime/production explanation and Manual-mode direction; same guard order and conditions. |
| `components/features/agent/AgentAutonomyDraftReview.tsx` | Include environment in the existing on-demand settings diagnostic only. Compact quote layout and handlers unchanged. |
| `.github/workflows/verify-chat-reference-preview.yml` | Include only the safe context enum in existing read-only evidence; no new requests, dispatch, enablement or deployment operation. |
| `config/route.test.ts`, `lib/api/autonomy-settings.test.ts`, `chat-autonomy-review.test.ts` | Source-header, privacy/fallback, precise copy, Production-vs-Preview and complete mocked-gate matrix coverage. |
| `activation-route-audit.test.ts` | Test both missing and explicitly false runtime flags; assert zero policy/goal/slot store calls as well as unchanged record counts. Existing production refusal and own-goal lifecycle tests rerun. |
| `tests/mobile/main.tsx`, `tests/mobile/review.spec.ts` | Add missing-runtime, actual combined Preview posture and missing-adapter fixtures. Verify disabled action, exact copy, zero activation calls and navigation to existing Manual content. |

## New validation

- Red baseline: **7 failed / 58 passed** across the initial message/header regressions, before implementation.
- **274 focused tests / 14 files passed**, no telemetry preload. Includes all required missing runtime, missing production gate, stale quote, wrong network, disconnected wallet and missing adapter cases, plus own-goal authorization, cold-start/production safety, compact fee/risk UI, existing controller and Manual launcher tests.
- **70/70 mobile browser cases passed**, 35 each at **360×800 and 390×844**. Fully ready fixtures enable; each missing prerequisite disables; Preview gate refusal points to Manual, which opens through the existing launcher without an activation call. All earlier compact quote, fee, expiry, focus/keyboard, overflow, repeated-tap, refresh and Manual behavior cases rerun.
- **TypeScript passed. Lint: 0 errors / 59 existing warnings.**
- Workflow YAML and generated TypeScript syntax parsed successfully without executing the network test or dispatching any workflow.
- `git diff --check` clean. No new dependency/lockfile change. Full local suite/build not rerun for this narrow follow-up; no historical full-suite/build totals are presented as new validation. Exact new-head hosted CI status is reported at delivery.

### Persistence guarantees independently verified

Missing/false runtime → **404 `AUTONOMY_DISABLED`** for policy, goal and permission POSTs. Missing/false production gate with runtime otherwise enabled → **503 `PRODUCTION_GATE_DISABLED`**. Both matrices leave **zero new policy, goal or permission records** and call none of `createPolicy`, `createGoal`, `saveSlots`. The single policy used to exercise goal admission is deliberately seeded in offline setup **before closing the gate**, then remains unchanged. No broadcaster calls. The existing positive mocked Mainnet lifecycle still requires a persisted own-goal permission before ACTIVE; it never verifies settlement or broadcasts.

No changes to `.env.example`, Vercel settings/scopes, gate definitions, emergency KV, secrets, contracts, signing/Permit2, Executor routing, fee arithmetic, quote generation, Manual swap behavior or AI vendors. No real wallet signatures, live authorization/goals/trades, broadcasts or production writes. All local state/signing fixtures are isolated doubles/test keys. Browser emulation is not physical-device, direct authenticated Preview UI or live-wallet acceptance.

Evidence excerpts and safe baseline annotation: [results](evidence/pr113-preview-diagnosis/results.txt). Updated production-gate copy in isolated mobile fixtures: [360](evidence/pr113-preview-diagnosis/360-preview-gate.png) / [390](evidence/pr113-preview-diagnosis/390-preview-gate.png).
