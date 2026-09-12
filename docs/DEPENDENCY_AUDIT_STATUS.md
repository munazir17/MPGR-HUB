# Dependency advisory status (supersedes the Aug 23 2026 snapshot)

The Aug 23 2026 review reported 37 advisories (1 critical, 6 high, 30
moderate) against the installed tree at commit `839d290`, and advised:
*"do not run a blind forced upgrade. Create separate upgrade PRs,
inspect production reachability, add smoke tests, and use Dependabot
or Renovate."*

That advice still stands, and this document does not bump any
dependency versions — it records what's verifiable about the *current*
`package.json`/`package-lock.json` so upgrade work can be prioritized
correctly, without needing to blind-guess or blind-bump.

**How this was checked:** this environment has no network access, so
`npm audit` could not be run here. The items below were checked
individually against public advisory sources instead. Run `npm audit`
yourself as the source of truth before treating this as complete —
this is a starting point, not a replacement for that.

## Already patched in the current lockfile (no action needed)

- **`next` — pinned exactly to `15.5.24`.** This is the exact patched
  release for the two critical unauthenticated-RCE advisories disclosed
  25 Aug 2026 (CVE-2026-75604, Windows path traversal; and the AVIF/
  libheif heap overflow, GHSA-2xp9-vwfh-vxw4). Whatever the "1
  critical" in the Aug 23 report referred to, the Next.js version
  currently pinned is already current against the most severe Next.js
  advisories disclosed since. No change needed; just don't let a future
  dependency bump silently pull this back below `15.5.24`.

- **`axios` — resolves to `1.20.0`** (locked in `package-lock.json`,
  and the `overrides.axios: "$axios"` entry forces every transitive
  `axios` in the tree, including a nested `1.16.0`-declared dependency,
  to the same resolved version). `1.20.0` is well past `1.13.2`, the
  version that patched the critical SSRF advisory CVE-2026-40175
  (CVSS 10). No change needed.

## Already has a documented, reasoned exception process

`scripts/audit-high.mjs` already implements exactly the "separate,
tracked exceptions" pattern the Aug 23 review asked for: it runs
`npm audit`, and only fails CI on a high/critical advisory that is
**not** on its explicit allowlist. The current allowlist (with
rationale already written down in the script) covers four
Solana/Coinbase-CDP transitive packages — `@coinbase/agentkit`,
`@solana/buffer-layout-utils`, `@solana/spl-token`, `bigint-buffer` —
on the grounds that the application has no direct Solana code path and,
for `bigint-buffer`, no safe patched release exists upstream yet. This
is infrastructure the review wanted; it already exists and is wired
into `npm run check`.

## Not verified here — needs a real `npm audit` run

Everything else in the original 37-advisory count (the moderate-
severity bulk, and anything not covered above) could not be checked
without network access in this environment. Concretely still open,
per the Aug 23 advice:

- **Run `npm audit` in an environment with registry access** and diff
  the result against `scripts/audit-high.mjs`'s allowlist — anything
  high/critical and *not* already on that list is the real remaining
  work, not a number carried over from the Aug 23 report.
- **`vitest` is pinned to an exact `4.1.11`** (dev-only, does not ship
  to production) and **`wagmi`/`viem` are on caret ranges** — no
  critical advisory was found against the real `wagmi`/`viem` packages
  during this check (only typosquat/malicious lookalike packages with
  similar names, e.g. `wagmi_util`, `@wrenfield/viem`, `wagmi-demo` —
  none of which appear in this project's dependency tree). Still worth
  a routine minor/patch bump check since these move quickly.
- **Wire up Dependabot or Renovate** (per the original advice) so this
  stops being a manual, point-in-time check at all.

## Why this repo doesn't ship a bulk version-bump PR

Several of the originally-reported advisories require **major**
version upgrades (the review specifically named Next.js, Vitest, and
Wagmi paths). A major bump to any of these can break the build or
change runtime behavior in ways that can't be verified without
actually running `npm install`, the build, and the test suite —
none of which was possible in this environment (no network egress).
Shipping unverified major-version edits to `package.json` for a
financial-rewards application would trade a known, contained risk
(some moderate advisories) for an unknown one (an unbuilt, untested
dependency tree in production). Per the original advice: do this as
separate, tested upgrade PRs, one dependency family at a time.
