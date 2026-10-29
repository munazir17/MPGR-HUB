# Target modular structure

This is a dependency diagram, not a move plan. Do not rename `lib/` to `modules/` in one PR. Create a shared module only when a second caller is being migrated in that same PR.

```text
app/                      routes and route handlers only
components/
  ui/                     primitives: card, empty, skeleton, stat
  layout/                 navbar, sidebar, page shell
  features/<feature>/     feature UI, not imported by unrelated features
hooks/                    feature hooks; one live chain reader per concern
lib/
  chain/                  chain id, RPC, live-read policy
  auth/                   session
  api/                    redis, request guard
  rewards/                ledger, amounts
  games/
    catalog/              registry, shell types (future)
    mpgr-run/             runner only
    <future-game>/        one folder per game
  swap/                   PaigerSwap, including v2
  trade/                  agent quotes
  executor/               fee + ABI mirror
  staking/  token-lock/  token/
contracts/                Solidity. App code does not deploy from a UI PR
```

## Dependency direction

```text
app → components/features → hooks → lib/<feature>
app/api → lib/<feature> → lib/api | lib/auth | lib/chain
lib/swap  ↛  components
lib/games/mpgr-run  ↛  app/page.tsx
contracts  ↛  React
```

Public exports stay the current `@/` alias. A barrel file is optional and not worth adding until a feature has a stable surface (`lib/games/index.ts` already exists and should not re-export the canvas).

## Import rules

1. A page imports its feature component and the layout. It does not import another feature's hook to "just show a number" unless that hook has a snapshot mode, as holder tier now does.
2. API routes validate, authorize, and call a lib function. They do not reimplement fee or XP arithmetic.
3. Redis key strings stay next to the module that owns the data. A later key index can re-export them. Do not invent a second prefix.
4. Wallet signing components stay at the edge: agent confirm modals, swap execution dialog. Lib code returns unsigned transactions.
5. Game assets are referenced only from `lib/games/<id>` and that game's components.

## UI catalog (what to share vs keep local)

| Share | Keep local |
| --- | --- |
| Page shell, nav config (future), `GlassCard`, empty/skeleton/stat, focus and button cursor | PaigerSwap form, agent transcript, run canvas and HUD, staking modals |
| One connect button style (future) | RainbowKit modals themselves |
| Error and loading copy pattern | Quote error strings that encode fee or simulation failure |

Do not build a generic `<DataTable>` or `<Modal>` that takes 20 props. The swap `<dialog>` is already the right shape for swap.

## Backend catalog

| Service | Owner | Notes |
| --- | --- | --- |
| Session | `lib/auth` | Cookie + Redis |
| Rate limit | `lib/api/request-guard.ts` and `lib/trade/trade-rate-limit.ts` | Separate buckets |
| XP ledger | `lib/rewards/xp-ledger.ts` | Only `INCRBY` of totals |
| Game sessions | `lib/games` + `app/api/games/mpgr-run` | Replay before XP |
| Quotes | swap, trade, mcp | Three edges, one fee rule eventually |
| Chain reads | staking, token-lock, token balance services | Poll policy is now explicit |
| Crons | `vercel.json` | Settlement only |

## Existing vs proposed

Existing and in use: everything in the inventory except the files this branch adds (`lib/chain/live-read-policy.ts` and its test, `hooks/navbar-live-read.test.ts`, this `docs/architecture/` set).

Proposed, not created: `lib/content/nav.ts`, `components/ui/DialogShell.tsx`, `lib/rewards/xp-actions.ts` (only if split from `xp-engine`), `lib/games/shell/`, a quote kernel. Do not add them until the roadmap item that needs them.
