# Target architecture

Modular monolith. One Vercel deploy. One Redis. One chain config. New features are folders and adapters, not new services.

Microservices are out of scope until a measured bottleneck is isolated to one domain and the deploy/ops cost is justified. That condition is not met.

## Frontend

### Tokens and primitives (keep the current look)

Already real: Tailwind theme in `tailwind.config.ts` and CSS variables / `.btn-*` in `app/globals.css`. PaigerSwap’s zinc/emerald dialect stays. Do not restyle it onto hub gold.

Allowed in `components/ui` after the move:

- `Button` styles stay CSS classes (do not add a second button library).
- `GlassCard`, `StatCard`, `EmptyState`, `Skeleton`, `ProgressBar`, `SectionHeader`, `DialogShell` (new, P1).
- Wallet button wrapper (new, P1) with three visual slots: navbar, sidebar, compact. Same wagmi action.

Not allowed in `components/ui`: staking forms, reward claim cards, game canvas.

Feature folders, unchanged in spirit:

| Folder | Owns |
| --- | --- |
| `features/swap` | PaigerSwap only |
| `features/agent` | Chat, autonomy, agent confirms |
| `features/games` | Catalog shell |
| `features/games/mpgr-run` | Heavy game, route-split |
| `features/games/<light-id>` | One canvas module each, dynamic import |
| `features/staking`, `token-lock`, `burn`, `campaigns`, `season-pass`, `premium` | Those products |
| `markets` | Tape and pair sheet |
| `layout` | Navbar, sidebar, page shell |

### Import rules

1. `app/**/page.tsx` may import a feature root and the layout. It does not import `run-render`, `run-assets`, or `mcp-trade-service`.
2. `features/swap` does not import `features/agent` or `components/ui` reward cards. Shared types come from `lib/trade/trade-types.ts`.
3. `features/games/mpgr-run` is only imported by `app/games/mpgr-run/page.tsx` (or a dynamic wrapper in that file).
4. Hooks that hit the chain on an interval are imported by the page that needs them, not by `Navbar`.
5. No new `localStorage` writer for a value that Redis already stores, except as a cache written from a server response.

### Server vs client

- Root layout stays a server component.
- Docs, whitepaper, terms: server content. They may keep a thin client navbar, but they should not load the agent chat graph. A route group `(wallet)` vs `(info)` is the clean split (P1). Both can still share CSS.
- Product data stays request/response until a screen needs caching. Adding React Query everywhere is not the goal. If it is added, start with the tape and the MPGR balance, one hook, with a documented stale time.

### Loading and errors

Add `error.tsx` only on `(wallet)` and on `/games/mpgr-run` when those layouts exist. Message must stay the existing plain-language style, not a stack trace.

Optimistic UI: allowed for check-in and game XP only if the row says “pending” until `awarded: true`. Rollback = replace with `GET /api/xp`. Never optimistic for a token transfer.

## Backend domains

| Domain | Models and invariants | Use cases | Persistence | Adapters | Do not |
| --- | --- | --- | --- | --- | --- |
| Identity | Cookie session = wallet + 8453; nonce single use | verify, logout, `authenticateRequest` | Redis session + nonce | `/api/auth/*` | Trust `body.wallet` |
| Trading | Quote ≠ prepared tx ≠ submitted tx ≠ receipt. Fee floor matches the contract. | quote, prepare, verify receipt | Quote id HMAC, short TTL. No fill database. | `/api/swap`, `/api/swap/v2`, `/api/trade`, MCP | Sign on the server for the user |
| Portfolio | Balances are chain reads, cached briefly | read MPGR, staking, locks | in-memory per isolate; chain is source | wagmi hooks | Invent balances in localStorage |
| XP | Totals monotonic. Season is a month bucket. Streak is not a balance. | award(eventId), get standing | Redis, no TTL on totals | `/api/xp`, game reward, referral | Client-supplied amounts |
| Games | Server seed, replay or bounded score, idempotent session | session, result | Redis | `/api/games/*` | Share MPGR Run replay with other games |
| Campaigns | Caps and idempotent action ids | record action | Redis | `/api/campaigns` | Pay XP from the browser |
| Agent | Model output is untrusted. Tools are deterministic. | complete, tool call | AI budget keys; chat memory is not a ledger | `/api/agent/complete`, AgentKit | Let the model pick a fee or a recipient |
| Autonomy | Default off. Reserves before spend. | tick, goals | Redis day ledger | `/api/agent/autonomy` | Enable in an architecture PR |
| Markets | Read-only tape | snapshot | short server cache | `/api/market` | Route swaps |
| Notifications | **L** — no toast system, no push | — | — | — | Build a framework unused |

Application services stay in `lib/<domain>`. Route handlers: auth, parse, rate limit, call service, map status codes. That is already true for XP and game reward. It is only partly true for AI (OpenAI route vs shared helper).

### API shape (tighten gradually)

Do not big-bang a new envelope. New endpoints should use:

- Success: existing domain JSON (do not wrap XP or quotes in `{ data }` until clients migrate).
- Error: `{ error: string, code: string }` plus `X-Request-ID` and `Cache-Control: no-store`.
- Auth: `authenticateRequest` for user mutations.
- Idempotency: `SET NX` on a caller-supplied id that the server constrains (session id, UTC day, quote id). Not a free-form amount.

Pagination: leaderboard and histories should take `limit` (already implicit top-N). Do not return full zsets.

### Wallet safety (unchanged)

- No private keys in the client bundle. `REWARD_MANAGER_PRIVATE_KEY` and broadcaster keys stay server-only.
- No `NEXT_PUBLIC_` secret.
- Simulation or fee mismatch fails closed. No silent fallback to a fee-less route on the swap product.
- Agent may prepare. The wallet confirms. Autonomy stays flag-off.

## Data

Redis remains the system of record for off-chain points. Postgres is **not** recommended until one of these is measured:

- A query that Redis cannot serve with an index we already have (example: “all XP events for a wallet, paged, 90 days”).
- Value size or hot-key latency on `mpgrhub:xp:rank` or campaign zsets.

Until then: cap leaderboard reads, pipeline the N+1 `GET`s, and set TTLs only on operational keys (sessions, rate limits, daily caps). Do not TTL the XP total again (that bug was fixed on purpose).

RPC: one shared server-side client with the existing URL list (`lib/chain/rpc-endpoints.ts`), timeout, and cap on fan-out. Browser polling is the first thing to cut, not a new provider cluster.

Jobs: keep the two crons. Do not add BullMQ for streaks or games. A light game does not need a worker.

Observability gap (**U** today): structured logs exist; metrics and traces do not. First metric set when implementing the navbar change: RPC calls per document, Redis commands per `/api/xp`, asset bytes on the game route.

## Game module boundary

```text
app/games/page.tsx
  -> catalog (metadata only, small images)
app/games/[id]/page.tsx          # future
  -> dynamic(() => import(game))
lib/games/shell/types.ts         # start/pause/finish
lib/games/mpgr-run/**            # unchanged verifier
lib/games/reaction-tap/**        # future, pure functions + tests
```

The shell does not import `run-render.ts`.

## 100x shape (still one app)

- Static art cached at the CDN, small critical set.
- Chain reads on the pages that show those numbers, not on every navigation.
- Redis award scripts stay O(1) per event.
- AI budget already daily-capped.
- Swap/quote rate limits stay per wallet and per IP.
- Failures of DexScreener, an AI vendor, or the game verifier do not 500 the swap page. They already mostly don’t (separate routes). Keep it that way: no shared god layout data fetch.
