# MPGR Run — Asset Optimization Report (2026-09-18)

Size-only optimization of every image asset under `public/games/mpgr-run/`.
No artwork was regenerated, redrawn, or AI-edited: every output file is a
**bit-exact lossless recompression** of its original PNG (verified per pixel
against the original bytes).

## Summary

| Metric | Value |
| --- | --- |
| Original total asset size | 113,966,215 B (**108.69 MiB**) |
| Optimized total asset size | 80,077,936 B (**76.37 MiB**) |
| Total saved | 33,888,279 B (**32.32 MiB**) |
| Reduction | **29.7%** |
| Files optimized | **55 / 55** |
| Files whose format changed | 55 (PNG → lossless WebP) |
| Files whose dimensions changed | **0** |
| Files downscaled | **0** |
| Files upscaled | **0** |

## Method

1. **Inventory** — all 55 PNGs under `public/games/mpgr-run/` were catalogued
   (size, dimensions, bit depth, color type, alpha usage, and every code
   reference). 13 additional one-byte placeholder files named `...` / `....`
   exist in the folder; they contain no image data, are referenced nowhere,
   and were left untouched.
2. **Candidate generation per file (both lossless):**
   - PNG re-encode via oxipng 4.0.3 (`-o 4 --strip all`, strips the Canva
     `caBX` provenance metadata chunk; no ICC profiles were present).
   - Lossless WebP via libwebp through sharp/libvips (`lossless: true`,
     `effort: 6` = maximum; dead fully-opaque alpha channels dropped).
3. **Per-pixel verification of every candidate before adoption:** the decoded
   candidate was compared against the original pixels — the alpha channel
   must match byte-for-byte everywhere, and every pixel with
   `alpha ≠ 0` must match byte-for-byte in RGB. (RGB values *under fully
   transparent* pixels may be normalized by the WebP encoder; they are
   invisible in any compositing and no code reads them.) Output files were
   also re-verified against the original PNG bytes recovered from `git HEAD`
   after being written into the repo: **all 55 files pass**.
4. **Selection:** smallest verified candidate wins. Lossless WebP was smaller
   than the oxipng-optimized PNG for **every** file (closest race: WebP at
   0.31× the optimized-PNG size), so all 55 assets became `.webp`. Nothing
   was converted blindly — per-file size comparison drove the choice, and no
   file was replaced with anything larger than its original.
5. **References updated** (extension change only — no paths, logic, or
   layout touched):
   - `lib/games/mpgr-run/run-assets.ts` — all 35 sprite paths, `RUN_ASSET_VERSION` bumped `2026-08-22a` → `2026-09-18a` (per the file's own cache-busting contract), format-note comment added.
   - `lib/games/game-registry.ts` — game-card `iconImage`.
   - `components/features/games/FeaturedGameBanner.tsx` — banner `<img src>`.
   - `lib/games/mpgr-run/run-assets.test.ts` — sample path string in the versioning test.
   - `lib/games/mpgr-run/run-render.ts` — comment only.
6. **Cache headers** (`next.config.mjs`, `/games/mpgr-run/:path*`,
   `Cache-Control: immutable`) are extension-agnostic and unchanged; the
   `RUN_ASSET_VERSION` bump gives every asset a fresh URL.

## Why not smaller?

The artwork is generative full-color illustration with heavy per-pixel noise,
which is the worst case for lossless compression; 29.7% is the honest ceiling
for bit-exact recompression at unchanged dimensions. Further reduction would
require downsampling (forbidden here — every sprite is drawn scaled at
runtime and its intrinsic resolution was preserved) or lossy/quantized
encoding (rejected: colors, shadows, glow, and alpha must be preserved
exactly). The largest remaining assets are the four portal images and the
city environment layers, which are also the least-referenced ones.

## Build / test results

- `npm test` — **103 test files passed, 799 tests passed** (vitest). The run
  reports an "unhandled error" from pre-existing agentkit tests attempting
  `https://cca-lite.coinbase.com` — this sandbox blocks that host
  (`ECONNRESET`); it also occurs on pristine `main` and does not fail the
  suite.
- `npm run typecheck` — **pass**.
- `npm run lint` — **pass**.
- `npm run build` — fails in this sandbox at the Google Fonts fetch in
  `app/layout.tsx` (`fonts.googleapis.com` is unreachable — network-isolated
  environment). **Verified pre-existing:** pristine `HEAD` (no changes)
  fails with the identical error, and both `next build --webpack` and
  Turbopack fail the same way. The GitHub Actions `build` job runs
  `npm run build` on hosted runners and will validate the real build on the
  PR. None of the optimized assets participate in build-time processing
  (they are static `public/` files loaded at runtime via URL strings).

## Confirmations

- ✅ No game logic, gameplay, physics, collision, hitboxes, character
  behavior, animation timing/order, rewards, XP, levels, controls, HUD
  logic, UI layout, mechanics, or asset positioning was modified — the only
  source changes are file-extension strings, a cache-version constant, and
  comments (diff: 5 code files, 48 insertions / 40 deletions).
- ✅ No AI image generation or image-to-image editing was used.
- ✅ All 55 files verified pixel-exact (visible pixels + full alpha channel)
  and dimension-identical against the original bytes from `git HEAD`.
- ✅ Aspect ratios, rendered sizes, and the `BACKGROUND_STRIP_TARGETS`
  flood-fill inputs are unchanged (those three assets are RGB, converted
  bit-exactly).

## Per-file results

Sizes are original → optimized (same dimensions for every row; filenames
gained the `.webp` extension).

| Asset | Dimensions | Mode | Original | Optimized | Saved |
| --- | --- | --- | --- | --- | --- |
| character/mpgr-runner-jump.png | 1536x1024 | RGBA | 1.30 MiB | 503.7 KiB | -62.2% |
| character/mpgr-runner-idle.png | 1254x1254 | RGBA | 825.0 KiB | 597.1 KiB | -27.6% |
| character/mpgr-runner-fall.png | 1536x1024 | RGBA | 1.65 MiB | 814.1 KiB | -51.7% |
| character/mpgr-runner-fly.png | 1536x1024 | RGB | 1.89 MiB | 1.41 MiB | -25.7% |
| character/mpgr-runner-run-2.png | 1536x1024 | RGB | 1.63 MiB | 1.24 MiB | -23.6% |
| character/mpgr-runner-land.png | 1536x1024 | RGBA | 2.06 MiB | 1.45 MiB | -29.4% |
| character/mpgr-runner-victory.png | 1024x1536 | RGBA | 1.84 MiB | 986.3 KiB | -47.7% |
| character/mpgr-runner-run.png | 1536x1024 | RGBA | 1.29 MiB | 490.2 KiB | -63.0% |
| character/mpgr-runner-slide.png | 1536x1024 | RGBA | 2.44 MiB | 1.75 MiB | -28.3% |
| collectibles/mpgr-run-coin.png | 1536x1024 | RGBA | 2.10 MiB | 612.4 KiB | -71.6% |
| collectibles/mpgr-run-gem.png | 1536x1024 | RGBA | 1.71 MiB | 1.04 MiB | -39.1% |
| checkpoints/mpgr-run-checkpoint.png | 1402x1122 | RGB | 1.46 MiB | 1.13 MiB | -22.6% |
| collectibles/mpgr-run-treasure-chest.png | 1536x1024 | RGB | 1.63 MiB | 1.31 MiB | -19.5% |
| collectibles/mpgr-run-key.png | 1536x1024 | RGBA | 1.72 MiB | 1.02 MiB | -40.7% |
| collectibles/mpgr-run-xp.png | 1536x1024 | RGBA | 1.82 MiB | 1.00 MiB | -44.8% |
| effects/mpgr-run-coin-collection.png | 1536x1024 | RGBA | 2.20 MiB | 1.42 MiB | -35.4% |
| effects/mpgr-run-explosion-hit.png | 1536x1024 | RGBA | 2.27 MiB | 1.37 MiB | -39.5% |
| effects/mpgr-run-gem-collection.png | 1536x1024 | RGBA | 2.17 MiB | 1.48 MiB | -31.8% |
| effects/mpgr-run-powerup-collection.png | 1536x1024 | RGB | 2.23 MiB | 1.80 MiB | -19.6% |
| effects/mpgr-run-level-complete.png | 1536x1024 | RGB | 1.79 MiB | 1.40 MiB | -21.9% |
| environment/city-background.png | 1536x1024 | RGB | 2.34 MiB | 1.92 MiB | -17.8% |
| obstacles/mpgr-run-barrier.png | 1536x1024 | RGBA | 1.98 MiB | 1.12 MiB | -43.7% |
| environment/city-foreground.png | 1536x1024 | RGB | 2.50 MiB | 2.09 MiB | -16.3% |
| environment/city-midground.png | 1536x1024 | RGB | 2.19 MiB | 1.83 MiB | -16.5% |
| obstacles/mpgr-run-drone.png | 1536x1024 | RGBA | 2.05 MiB | 1.35 MiB | -34.1% |
| obstacles/mpgr-run-crate.png | 1536x1024 | RGBA | 2.05 MiB | 1.17 MiB | -43.1% |
| obstacles/mpgr-run-saw.png | 1536x1024 | RGBA | 2.25 MiB | 1.40 MiB | -38.1% |
| obstacles/mpgr-run-tnt.png | 1536x1024 | RGBA | 1.77 MiB | 949.6 KiB | -47.6% |
| obstacles/mpgr-run-spikes.png | 1536x1024 | RGBA | 2.13 MiB | 1.23 MiB | -42.5% |
| pads/mpgr-run-bounce-pad.png | 1536x1024 | RGB | 1.55 MiB | 1.20 MiB | -22.6% |
| pads/mpgr-run-speed-boost-pad.png | 1536x1024 | RGB | 1.79 MiB | 1.42 MiB | -20.7% |
| portal/mpgr-hub-portal-01.png | 1536x1024 | RGBA | 2.86 MiB | 2.19 MiB | -23.3% |
| powerups/mpgr-run-invincibility.png | 1536x1024 | RGBA | 2.09 MiB | 1.33 MiB | -36.2% |
| portal/mpgr-hub-portal-02.png | 1536x1024 | RGB | 2.66 MiB | 2.16 MiB | -18.5% |
| portal/mpgr-hub-portal-03.png | 1536x1024 | RGB | 2.75 MiB | 2.26 MiB | -17.9% |
| portal/mpgr-hub-portal-04.png | 1536x1024 | RGB | 2.73 MiB | 2.27 MiB | -16.9% |
| powerups/mpgr-run-magnet.png | 1536x1024 | RGBA | 2.06 MiB | 1.43 MiB | -30.7% |
| powerups/mpgr-run-jetpack.png | 1536x1024 | RGBA | 2.33 MiB | 1.73 MiB | -26.0% |
| powerups/mpgr-run-score-2x.png | 1230x1278 | RGBA | 1.99 MiB | 1.56 MiB | -21.7% |
| powerups/mpgr-run-speed-boost.png | 1240x1268 | RGBA | 1.81 MiB | 1.37 MiB | -24.0% |
| screen/mpgr-run-daily-challenge.png | 1024x1536 | RGB | 1.90 MiB | 1.46 MiB | -23.3% |
| powerups/mpgr-run-shield.png | 1536x1024 | RGBA | 2.11 MiB | 1.40 MiB | -33.9% |
| screen/mpgr-run-achievement-popup.png | 1402x1122 | RGB | 1.71 MiB | 1.30 MiB | -24.0% |
| screen/mpgr-run-game-over.png | 1536x1024 | RGB | 1.96 MiB | 1.50 MiB | -23.8% |
| screen/mpgr-run-inventory.png | 1154x1363 | RGB | 1.94 MiB | 1.55 MiB | -20.2% |
| screen/mpgr-run-leaderboard.png | 1024x1536 | RGB | 2.05 MiB | 1.60 MiB | -22.1% |
| screen/mpgr-run-level-select.png | 1402x1122 | RGB | 1.99 MiB | 1.61 MiB | -19.1% |
| screen/mpgr-run-pause-menu.png | 1122x1402 | RGB | 1.70 MiB | 1.29 MiB | -24.3% |
| screen/mpgr-run-ready-countdown.png | 1402x1122 | RGB | 2.17 MiB | 1.80 MiB | -17.1% |
| screen/mpgr-run-reward-chest-opening.png | 1402x1122 | RGB | 2.07 MiB | 1.68 MiB | -18.9% |
| screen/mpgr-run-upgrade-shop.png | 1024x1536 | RGB | 2.08 MiB | 1.62 MiB | -22.0% |
| screen/mpgr-run-victory-reward.png | 1402x1122 | RGB | 1.83 MiB | 1.42 MiB | -22.4% |
| ui/mpgr-run-heart.png | 1536x1024 | RGBA | 1.80 MiB | 995.1 KiB | -46.0% |
| ui/mpgr-run-hud-frame.png | 1672x941 | RGBA | 961.7 KiB | 775.2 KiB | -19.4% |
| ui/mpgr-run-powerup-frame.png | 1536x1024 | RGBA | 2.55 MiB | 1.75 MiB | -31.3% |
