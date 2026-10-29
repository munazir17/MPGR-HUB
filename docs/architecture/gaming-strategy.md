# Gaming strategy

## The 100 MB claim

**Verified at `3fb5eb82`:** the repo shipped ~100 MiB of `public/` and ~89 MiB of MPGR Run art.

**Verified after merged PR #145:** `public/` is 65,275,951 bytes (62.25 MiB) and `public/games` is 54,482,009 bytes (51.96 MiB). Critical preload is 7,822,192 bytes (21 paths). The full sprite catalog is still 45,357,918 bytes. Unreferenced `screen/`, `portal/`, and `pads/` art is gone. Legacy city panoramas stay as optional fallbacks.

**Not verified:** that every player transfers those bytes on each open. A connected play session requests the critical lane first, then optional sprites, plus **2.5 MiB** of WAV if music mounts. First load on a phone is still heavy. It is not “the whole public folder.” Production transfer size was not measured.

Repeat visits are helped by immutable caching. A version bump redownloads everything that changed URL.

## Three options

| | A. Remove games | B. Keep MPGR Run, isolate assets | C. Light 2D games in the hub, MPGR Run optional |
| --- | --- | --- | --- |
| User value | Loses the only playable game and the weekly loop the UI advertises | Keeps the game people already have | Keeps a daily reason to open the hub without the art cost |
| Retention | High risk | Unchanged if load time drops | Better if sessions start in under a second |
| Performance | Best | Good if critical lane shrinks and dead art leaves `public/` | Best for the shell. MPGR Run stays off the dashboard bundle (already true) |
| Maintenance | Deletes a large tested surface (replay, settlement, crons) | Art and renderer stay expensive | New small games plus a frozen MPGR Run |
| Reward integrity | Must not orphan weekly records or the settlement cron without a migration | Unchanged | New games need their own server rules. Do not reuse MPGR Run replay for a different ruleset |
| Recommendation | No | Do this **first** | Do this **second**, behind the existing catalog |

**Choice: B now, C as the platform, MPGR Run kept as an optional heavy game.** Not A.

Reasons:

- Reward code is real and fail-closed (`app/api/games/mpgr-run/reward/route.ts`, authoritative replay, XP cap). Deleting it to save bytes throws away audited work.
- The dashboard already does not import `RunGame`. The byte problem is the play route and the git/deploy weight of unused files.
- A 1 MB canvas game can award the same flat participation XP later. It cannot share MPGR Run’s physics replay. Pretending it can would break anti-cheat.

## B — what to change when approved

P0 items 1 and 2 landed in PR #145 (delete unreferenced art; panoramas are optional; byte-budget test). The test locks the measured bytes. It does not use the aspirational 2 MiB / 12 MiB / 20 MiB ceilings below. Items 4 and 5 are still open.

1. Relocate or delete bytes that no loader requests: `screen/` (16.8 MiB), `portal/` (8.9 MiB), `pads/` (2.6 MiB), unused full-size HUD frames, `fly` / non-cutout originals, legacy skyline posters. Update `run-assets.files.test.ts`, which currently fails if portal art or side cutouts disappear. **Done in #145**, except side cutouts that the prebake script still reads were kept.
2. Move `CITY_ENVIRONMENT` background/mid/foreground (~5.8 MiB) from `CRITICAL_SPRITE_PATHS` to optional. The renderer already prefers the small facade/skyline/prop set and falls back if those are not decoded. **Done in #145.** Files remain on disk.
3. Add a unit test: `CRITICAL` ≤ 2 MiB, `ALL_SPRITE_PATHS` ≤ 12 MiB, `public/games` ≤ 20 MiB after the deletion. Start looser if step 2 alone cannot hit 2 MiB, then tighten. Do not recompress visible pixels blindly. **Partial:** a regression lock exists at the measured 7.46 MiB critical / 43.26 MiB catalog / 51.96 MiB `public/games`. The tighter ceilings are not met and were not forced.
4. Transcode `neon-circuit.wav` (2.52 MiB) to a short AAC/Opus loop or leave music opt-in. Separate PR. Do not block the image deletion on audio. **Not done.**
5. `next/dynamic` for `RunGame` so the disconnected game page does not parse the simulator. Small. Do it in the same PR only if the asset test is already green. **Not done.**

Acceptance: cold play, connected, transfers the new critical budget; a completed run still calls session → checkpoint → reward; existing reward tests pass; `/` network log contains zero `/games/mpgr-run/` sprite URLs.

Rollback: restore the files and the path arrays. URLs are content-addressed by `?v=`, so bump `RUN_ASSET_VERSION` only if a filename’s bytes change.

## C — lightweight catalog (design only)

Do not build these in the audit PR.

Shared shell, one chunk per game, no Phaser/Three in the hub bundle:

- Catalog endpoint or static module under 50 KB.
- Contract: `start`, `pause`, `resume`, `finish`, `error`. Score stays inside the module until `finish`.
- Server: `POST /api/games/:id/session` returns `sessionId` + seed. `POST /api/games/:id/result` accepts a trace the server can recompute. Client does not send XP.
- XP: participation only, fixed amount from `XP_ACTIONS`, idempotent on `sessionId`, daily cap. Performance can drive a **separate** seasonal board later. It must not mint a token amount from the client.
- Assets: procedural canvas (grid, shapes, type). No sprite sheets until a game proves it needs one. Budget **< 200 KB** per game including JS, not 1 MB, because these games have no art requirement.

Candidates worth building later, in this order:

| Game | Why | Server check |
| --- | --- | --- |
| Reaction Tap | One mechanic, no assets | Seeded delays; reject taps before the signal; cap score by round count |
| Memory Match | Small grid, still no bitmaps | Seeded deck; score = f(moves, time) recomputed |
| Daily pattern | One seed per UTC day, same puzzle for everyone | Replay the submitted path against the seed |

Skip Quick Dodge until input replay is specified. Do not add all three at once.

MPGR Run stays at `/games/mpgr-run` with its current API. The hub card can label it “Full game · larger download.”

`lib/games/game-registry.ts` already lists coming-soon ids whose routes do not exist. Either implement them as the light games or stop advertising them. **P** today.

## Points and streaks (no decay)

This matches the code today, and it is the rule to keep.

### Separate numbers

| Concept | Store | Changes on inactivity |
| --- | --- | --- |
| Lifetime XP | Redis `mpgrhub:xp:total:*` | Never decreases |
| Season points | Redis `mpgrhub:xp:month:YYYY-MM:*` | Not decreased. A new UTC month reads 0 because it is a different key. Old months remain. |
| Current streak | `localStorage` `mpgr_xp_v1_*` only | Not decreased by a timer. Next check-in after a missed UTC day sets it to **1** (not 0). |
| Best streak | **Absent** | — |
| Claimable token rewards | On-chain vault, flags off | Must not be confiscated for inactivity. No such path was found in the XP scripts. |
| Campaign points | Redis campaign zset | Cap rollback `DECRBY` only if a grant would exceed a cap, inside the same failed transaction. Not an inactivity penalty. |

Fixed grants (`lib/xp-engine.ts`): wallet connect 50 (once), daily check-in 20, profile 30, share 15, quest 40, referral 100, MPGR Run complete 8. Game daily cap **10** successful awards (`DAILY_XP_RUN_CAP`).

### Check-in rules (verified)

- Timezone: **UTC** date (`toISOString().slice(0, 10)`) on both client and `POST /api/xp`. The server ignores any client-supplied day and uses its own UTC date.
- Duplicate same UTC day: server `SET NX` on `daily-check-in:YYYY-MM-DD` no-ops. Client `performDailyCheckIn` no-ops if `lastCheckIn` is today.
- Late request: if the server has already rolled UTC midnight, the event id is the new day. There is no grace window.
- Streak is **not** in the POST body and **not** stored in Redis. Clearing site data, or a second device, resets the displayed streak without touching lifetime XP.
- Referral settlement runs only when the server check-in is newly awarded.

### Proposed streak rules (do not implement until approved)

Keep every rule above. Add:

- `mpgrhub:xp:streak:{wallet}` → `{ current, best, lastCheckInUtc }`.
- On a successful check-in award: if `lastCheckInUtc` is yesterday, `current += 1`, else `current = 1`. `best = max(best, current)`.
- If the user does nothing, do not write. Do not DECR XP. Do not DECR `best`.
- Client streak becomes a cache of this record (`GET /api/xp` returns it).
- Achievements `streak-7` and `streak-30` should read server `current` or `best` (product choice: “reach” means best). Decide before coding. Today they read the local current streak, so they can be cleared by storage loss and cannot be trusted for a token.
- Season rollover does not touch streak or lifetime XP. Season points naturally move to a new month key.
- Concurrent check-ins: the existing XP `SET NX` is the lock. Streak update must be in that same Lua, or two requests can double-increment. Do not do a read-modify-write in Node.

### Anti-abuse (already largely true for MPGR Run)

- Score is recomputed. Client `score` is not trusted.
- Trace bounds: version 1, ≤ 4096 events, tick alignment, must end in authoritative game over. Tolerances: distance 0.75, duration 20 ms, score 2.
- Session: server seed, 15 min TTL, max 3 live sessions, heartbeats required (max gap 25 s).
- Idempotency: run record `SET NX` and XP event `SET NX`. Daily cap counter is decremented on duplicates so a replay does not burn the cap.
- Response does not return an MPGR amount.
- Financial settlement still requires both operator flags. Leave them false.
- Local `processRunResult` can still show +8 XP before the server answers. The overlay should wait for 2xx or label the number “pending.” That is a UI honesty fix, not a formula change. **P1.**

### What not to do

- Do not pay tokens from a light game in the first version.
- Do not let a game POST `{ xp: N }`.
- Do not reset season points inside the lifetime key.
- Do not import MPGR Run’s 43 MiB manifest into a shared game shell.
