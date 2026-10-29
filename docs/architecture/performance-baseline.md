# Performance baseline

Measured on the git tree at `3fb5eb82` unless a row says otherwise. Compressed transfer depends on CDN gzip/br and is **U** except where the file is already WebP or WAV (those bytes are what the browser downloads).

## After merged PR #145 and this branch

These numbers replace the baseline tables below for the current tree. The tables stay so the delta is auditable.

| Slice | Files | Bytes | MiB |
| --- | ---: | ---: | ---: |
| `public/` | 180 | 65,275,951 | 62.25 |
| `public/games` and `public/games/mpgr-run` | 88 | 54,482,009 | 51.96 |
| `ALL_SPRITE_PATHS` | 61 | 45,357,918 | 43.26 |
| `CRITICAL_SPRITE_PATHS` | 21 | 7,822,192 | 7.46 |
| Optional sprites | 40 | 37,535,726 | 35.80 |

Legacy city panoramas are optional, not critical. `screen/`, `portal/`, `pads/`, and the unused full-size plates named in the baseline are gone. The navbar no longer runs the 15s staking/token-lock poll described in the RPC table. Staking, token-lock, and the home agent still do.

## Game and static payload (measured at `3fb5eb82`)

| Slice | Files | Bytes | MiB |
| --- | --- | --- | --- |
| `public/` | — | 104,134,908 | 99.31 |
| `public/games/mpgr-run` | 116 | 93,340,966 | 89.02 |
| WebP in that folder | 101 | — | 86.49 |
| `audio/neon-circuit.wav` | 1 | 2,646,044 | 2.52 |
| Asset paths exported from `run-assets.ts` | 71 | 48,023,172 | 45.80 |
| `ALL_SPRITE_PATHS` (preload list) | 61 | 45,357,918 | 43.26 |
| `CRITICAL_SPRITE_PATHS` | 24 | 13,941,098 | 13.30 |
| Optional sprites (ALL − critical) | 37 | 31,416,820 | 29.96 |
| WebP not in `ALL_SPRITE_PATHS` | 40 | — | 43.24 |

Critical set is dominated by three legacy city panoramas (~5.84 MiB together: background 1967 KiB, midground 1869 KiB, foreground 2139 KiB) plus the side-view slide pose (1794 KiB) and run-2 cutout (1150 KiB). Newer city facade/props/sky plates are tens of KiB.

Unreferenced-by-preload folders (still shipped in `public/`):

| Folder | MiB | Notes |
| --- | --- | --- |
| `screen/` | 16.81 | Menu mockups. Not in the canvas pipeline. |
| `portal/` | 8.88 | Kept on purpose by `run-assets.files.test.ts`. |
| `ui/` full-size frames | ~3.5 not in ALL | HUD uses 7.4 KiB and 27.2 KiB icons. |
| `pads/` | 2.62 | Not in `ALL_SPRITE_PATHS`. |
| Legacy side cutouts | ~1.79 | Exported, explicitly not preloaded. |

Non-game images that still hurt a cold visit if linked: `splash.png` 1.78 MiB, `icon.png` 1.51 MiB, `image.png` 1.50 MiB, `icon-1024.png` 1.05 MiB, `embed.png` 0.98 MiB, `og.png` 0.78 MiB. Favicon metadata correctly points at `icon-128.png` / `icon-180.png` (layout comment). Farcaster embed still points at `embed.png` and `splash.png`.

Cache: `next.config.mjs` sets `Cache-Control: public, max-age=31536000, immutable` on `/games/mpgr-run/:path*`, keyed by `RUN_ASSET_VERSION` (`2026-09-18a`). Repeat visits should not redownload. First visit and every version bump do.

README “76.37 MiB” matches the original 55 WebP files still on disk (80,077,936 bytes). Later art added ~12.65 MiB. The old number is not wrong historically. It is not the current tree.

## What a visit actually fetches (code, not a trace)

| Surface | Game bytes | Label |
| --- | --- | --- |
| `/`, `/swap`, `/rewards`, docs | No `RunGame` import. Rewards and `/games` can request the small card/banner WebPs (`loading="lazy"` on the card). | V structure, **U** exact waterfall |
| `/games/mpgr-run` before connect | JS module of `RunGame` is statically imported. Sprites start only after connect, inside `startRunAssetPipeline`. | V |
| After connect | Critical lane, concurrency 3, then optional concurrency 2. Gameplay does not wait; procedural fallback until decode. 8s timeout. Music: metadata preload, not in the sprite list. | V code, **U** device decode time |

`docs/mpgr-run-next-gen/asset-audit.json` records an older proof: 53 preloaded paths, 45,085,116 bytes. Current `ALL_SPRITE_PATHS` is 61 / 43.26 MiB. The JSON is a fixture, not the live manifest.

## JS bundle

| Measurement | Result |
| --- | --- |
| `next/dynamic` / `dynamic()` | **0** uses |
| Root `Providers` | wagmi + RainbowKit CSS + react-query on every route, including docs and the game |
| framer-motion | Not in the root layout import list. Pulled by `Navbar` → sidebar and by `GlassCard`, so it is on almost every product page |
| AgentKit / x402 | `serverExternalPackages` + client alias to `false` |
| Route JS gzip size | **U** — not re-measured. CI `build` job succeeded. A budget script does not exist. |

Suggested budget (target, not a claim about today):

| Budget | Target |
| --- | --- |
| Initial JS for a docs or marketing route | ≤ 250 KB gzip, wallet stack not included |
| Initial JS for the signed-in shell | Measure first. Do not set a fake number. |
| Main app must not request `/games/mpgr-run/*` sprites | Already true for dashboard routes. Keep it true with a test. |
| Critical game lane | ≤ 1.5 MiB compressed was the aspiration. Baseline was 13.30 MiB. After #145 the file bytes are 7.46 MiB, still above 1.5 MiB. Do not claim the aspiration is met. |
| Full preload list | ≤ 8 MiB was the aspiration. Catalog is still 43.26 MiB after #145. |
| `public/games` on disk | ≤ 15 MiB was the aspiration. After #145 it is 51.96 MiB. Menus/portals/pads are already gone. |

## API and RPC (structural, not timed)

No latency histogram was collected (**U**). Known amplifiers:

| Pattern | Where | Failure mode at 100x |
| --- | --- | --- |
| Navbar holder tier → `useStaking` + `useTokenLock` + `useMPGRBalance`, 15s | Was `Navbar.tsx` via `useHolderTier()` | **Changed on this branch.** Navbar passes `{ poll: false }`. Logged-out pages skip `getGlobalState`. Home still doubles staking/lock reads via `useAgentChat.ts`. |
| Same 15s polls | rewards hub, reward claim, swap balances (swap page only) | Predictable RPC bill linear in open tabs |
| 30s | premium, season pass, holder tier | same |
| Tape | `useTape.ts` → `/api/market/tape` | Server fan-out to DexScreener / Chainlink. Cache TTL env `TAPE_CACHE_TTL_SECONDS` default 10s. |
| Quote routes share one 15/min bucket name `trade-quote` | swap and trade | One product can starve the other per IP/wallet. Not a latency bug. A coupling bug. |
| Leaderboard `getRankedWallets` | `xp-ledger.ts` | For each zset member, extra `GET`s for total and season. Fine at tens of users. At 100x board size this is N+1. |
| In-process quote and tape caches | several `Map`s | Miss on every isolate. Thundering herd to RPC. |

Rate limits that do exist (Redis): AI 20/min plus daily token budgets, trade/swap 15/min, MCP 60/min per IP, auth verify 10/min, game session 10/min, checkpoint 30/min. Redis down ⇒ authenticated limiters 503 (fail closed).

## How to re-measure before claiming a win

1. Asset bytes: sum `stat` of `CRITICAL_SPRITE_PATHS` and `ALL_SPRITE_PATHS` (script already implicit in `run-assets.ts`). Check this into CI as a max-bytes test.
2. JS: `npm run build` and `@next/bundle-analyzer` or `.next` chunk sizes for `/`, `/swap`, `/games/mpgr-run`, `/docs`. Record gzip.
3. Network: one Playwright trace, cold cache, desktop and 390px, for `/` and `/games/mpgr-run` after connect. Record transferred bytes and request count.
4. RPC: log `eth_call` count per page load in dev. Do not “optimize” without that count.

Until those exist, do not quote a percentage speedup.
