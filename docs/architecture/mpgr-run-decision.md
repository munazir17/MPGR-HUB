# MPGR Run — keep, isolate, or retire

Decision: **keep the game (option A for the rules, option B for the loading).** Do not delete it. A later hub of small games (option D) can sit beside it. Option C (retire and replace) is not supported by usage data, because **usage data is unavailable**.

[PR #145](https://github.com/munazir17/MPGR-HUB/pull/145) is **merged**. It deleted unreferenced art and demoted the legacy panoramas. It is not a production-traffic measurement. The table below is the pre-#145 measurement. Current budgets are in [README.md](./README.md) and `run-asset-budget.test.ts`.

## What was measured at `3fb5eb82`

File bytes, not HTTP transfer. Compression and decode time were **not** measured. No mobile device trace was taken.

| Set | Files | Bytes | What it means |
| --- | ---: | ---: | --- |
| `public/` | 208 | 104,134,908 | Repo and hosting weight |
| `public/games/mpgr-run` | 116 | 93,340,966 | Same, game only |
| `ALL_SPRITE_PATHS` | 61 | 45,357,918 | What the play pipeline may fetch |
| `CRITICAL_SPRITE_PATHS` | 24 | 13,941,098 | Fetched first, concurrency 3 |
| `OPTIONAL_SPRITE_PATHS` | 37 | 31,416,820 | After critical settles, concurrency 2 |
| `audio/neon-circuit.wav` | 1 | 2,646,044 | Loaded from `RunGame` mount, played on countdown/running |

`RUN_ASSET_VERSION` is `2026-09-18a`. `next.config.mjs` marks `/games/mpgr-run/:path*` immutable for a year. A same-URL byte change without a version bump will stick in caches.

`screen/`, `portal/`, and `pads/` were on disk at the baseline and are **removed** by #145. They were not in `ALL_SPRITE_PATHS`. A visitor who never opens the game still does not download game sprites. The repo is lighter because those files are gone.

## Who downloads the game

- `RunGame` is a static import of `app/games/mpgr-run/page.tsx` only. No `next/dynamic` exists in the repo.
- The component renders after the wallet is connected. The JS module still parses on that route before then, because the import is static.
- `/`, Navbar, and `app/layout.tsx` do not import `RunGame`, `run-assets`, or `run-render`.
- `/games` and `/rewards` import score/achievement helpers and two small marketing images (`mpgr-runner-run-banner.webp` 46,360 bytes, `mpgr-runner-idle-card.webp` 37,390). They do not import the canvas.

So a dashboard visit does not transfer the 13.94 MB critical set. A cold visit to `/games/mpgr-run` can.

## Options

| Option | Verdict | Why |
| --- | --- | --- |
| A. Keep and optimize | Yes, as the asset PR | Critical lane is larger than the art the city renderer draws in steady state. Legacy panoramas are fallbacks. Side poses in the critical list are mostly unused by the rear-camera renderer. |
| B. Optional lazy module | Yes, next loading change after #145 | `next/dynamic` of `RunGame` with `ssr: false` keeps the game and gets its JS off the route's first parse. Assets stay behind the pipeline. |
| C. Retire and replace | No | No retention numbers. The reward route, replay, and weekly cron are real. Removal is irreversible from a player's point of view even if git can revert. |
| D. Hub of light games plus this one | Later | Registry already marks other games `coming_soon`. Build the shell first. Do not replace Run to justify the shell. |

## Success criteria if #145 merges

- Critical sprite bytes drop below 8 MB without a `RUN_ASSET_VERSION` bump for files whose bytes did not change.
- `run-assets.files.test.ts` and the new budget test stay green.
- A connected cold load of `/games/mpgr-run` still reaches a playable canvas (procedural fallback is acceptable for one frame).
- `/` and `/swap` network logs show no `/games/mpgr-run/*.webp`.
- Rollback is revert. Remaining filenames keep their immutable cache key. Deleted URLs 404.

## If someone later argues for retirement

Reversible plan, not approved now:

1. Feature-flag the route to the catalog card, leave files in git for one release.
2. Keep `POST /api/games/mpgr-run/reward` returning a stable "retired" code so old clients do not corrupt the ledger.
3. Do not delete Redis XP already granted.
4. Rollback is turning the flag back on. Asset deletion is a second PR after one week with no error spike.

## Instrumentation that is still missing

Privacy-conscious, no wallet in the event name beyond a daily salted hash if a count per player is required:

- `run_open`, `run_start`, `run_complete`, `run_quit` with duration bucket and viewport class.
- Count only. No trace upload for analytics.
- Compare 14-day unique openers to reward-route 2xx before any retire discussion.

Until that exists, retention is **unknown**.
