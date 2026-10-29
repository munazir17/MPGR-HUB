# Light game platform and points

Not built in this audit. MPGR Run stays the only playable game.

## Points rules (required, already true on the server)

| Rule | Where it is true | Where it is only local |
| --- | --- | --- |
| Lifetime XP never decreases because of inactivity | Redis totals and rank use `INCRBY` / `ZINCRBY` only. No decay cron. | `cacheServerXPTotals` may lower the **displayed** number to match the server. That is a cache correction, not a penalty. |
| A missed day may reset the current streak | Next `performDailyCheckIn` sets `streak` to 1 when `lastCheckIn` is not yesterday. Yesterday is `Date.now() - 86400000` as a UTC date, not a calendar subtraction. | No server streak. Nothing to reset on the server. |
| Missed day does not deduct XP or tokens | No such code path | Local achievements `streak-7` and `streak-30` lock again because they read the current streak. Claimed ids stay claimed. No XP is paid on claim. |
| No silent best-streak field | None exists in `*.ts` / `*.tsx` | Do not add one without an explicit product yes. |

Amounts, unchanged: wallet 50, check-in 20, profile 30 (no caller), share 15 (no caller), quest 40 (local only), referral 100 (server, after a real check-in, cap default 5/day), MPGR Run 8 (max 10 verified runs per UTC day).

Season points are the month key. A new UTC month reads a missing key as 0. The old month is not decremented. That is not a lifetime-XP loss.

## What a shared game shell would look like

Do not fork `RunGame`. A future game implements a small registration object:

```ts
type GameModule = {
  id: string;
  title: string;
  load: () => Promise<{ start: (host: HTMLElement) => void; stop: () => void }>;
  submitScore: (proof: unknown) => Promise<{ accepted: boolean; duplicate: boolean }>;
};
```

Rules:

- `load` is a dynamic import. The dashboard imports the registry row, not the module.
- Assets live under `public/games/<id>/` and are fetched only after `load`.
- Pause when `document.hidden` is true. Resume only on an explicit user action if the game spends points or XP.
- Score submission is server-authoritative, idempotent on a server-issued session id, and replayed or otherwise bounded. The client does not send an XP integer.
- Participation XP, if any, is a new `XP_ACTIONS` row approved in advance. Default is zero token payout. `GAME_REWARDS_ENABLED` stays off.
- Accessibility: keyboard and 44px targets, reduced motion skips screen shake, no autoplay audio.
- Budgets, per game, until a measurement says otherwise: critical JS gzip under 80 KB, critical art under 300 KB, no audio over 200 KB compressed. MPGR Run is over those budgets and is grandfathered, not the template.

## Candidates (design only)

| Game | Why it fits | Shared pieces | Do not reuse from Run |
| --- | --- | --- | --- |
| Reaction tap | One input, tiny art | Session, XP cap, catalog card | Canvas camera, sprite pipeline |
| Daily memory | Short session, no loop audio | Streak display can read the existing local streak; it must not write a second streak | Replay format |
| Endless runner | Already shipped | Keep as `mpgr-run` | — |
| Puzzle / target | Low asset count | Same score POST shape, different verifier | `computeRunScore` weights |

## Server ledger shape (proposal only)

Do not add keys in this PR. If a later approved change records a streak:

- New key `mpgrhub:xp:streak:{wallet}` and `mpgrhub:xp:checkin:{wallet}` updated in the **same** Lua script as the check-in `INCRBY`.
- Missed day: set streak to 1. Never `DECRBY` the total.
- Best streak: only if the product doc names the field. Otherwise omit it.
- Old clients keep working: if the server fields are absent, the UI keeps the local streak and still shows server XP.
- Idempotency stays `mpgrhub:xp:event:{wallet}:daily-check-in:{utc-date}`.

The campaign cap rollback (`DECRBY` on a failed grant counter) must not be copied onto the XP total.
