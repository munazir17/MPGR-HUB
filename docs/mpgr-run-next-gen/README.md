# MPGR Run — next-generation presentation work (DRAFT)

**2026-09-27. Not merge-ready.** This is a reviewable implementation checkpoint, not a claim that the final reference-quality/mobile-performance target has been met. The software-raster regression below must be resolved or convincingly ruled out through representative browser/device profiling before release. The attached reference guided composition/materials; it was not copied into the game.

## Git baseline and scope

- PR #62: `arena/01a0de47-mpgr-hub`, HEAD `5489ea0d978f6c1e39f824d934c58bc5db97cf02`.
- Arena session branch: `arena/01a0e201-mpgr-hub`. Fast-forwarded from `37dcc45` to that exact HEAD; no branch switch, reset, rebase, squash, force push, or parent-PR modification.
- Parent commits preserved: `b7cf51c` (rear camera/VFX/art), `3c19b0f` (worlds/weather/art), `2ba5908` (depth columns/coin arcs/head alignment), `5489ea0` (input classifier/scenery polish).
- Changes are limited to MPGR Run presentation, its input lifecycle, removal of client-only extra spawns, assets, tests, and this evidence. Authoritative replay, APIs, authentication, wallet, economy formulas, leaderboard, and all unrelated features are untouched.

## Baseline findings

PR #62 already implemented rear projection, eight rear poses, four-frame 165 ms cadence, per-frame lateral alignment, world-space VFX, city/ice/desert cycling, fog transitions, scenery columns, branded airships/props, and pointer-ID release matching/HUD propagation guards. Those were treated as the starting point, not reimplemented from scratch.

The renderer's 72-world-unit standing sprite produced only ~54 CSS pixels on a 390×844 canvas. Repeated isometric building cutouts were projected as flat cards; skyline/ground haze created a strong horizontal separation. The ice panorama contained a baked bright aurora band; the desert panorama had magenta boundary contamination. RunGame uses a fixed 60 Hz simulation, DPR capped at 2, a ResizeObserver, and the existing bounded two-tier asset loader.

Two input gaps remained: a 7–39 px horizontal movement fell through to jump, and a second pointer-down replaced the first pointer's ownership. The old test explicitly expected the replacement.

**Production safety finding:** PR #62's client simulation spawned five extra coins and consumed a gameplay RNG value for some jump obstacles. The authoritative replay did not. These were not presentation-only changes: they could diverge the random stream and rewards. The user explicitly selected preservation of authoritative gameplay rather than extending the reward/spawn rules.

## Implemented here

- Runner height is 16.5% of game-canvas height, with shared object/jump scaling. Horizon at 43%, player ground at 84%; lane width is portrait-width/landscape-height bounded. Existing classic `runViewScale`/`runCameraOffsetX` contracts remain intact.
- Building sides and near faces are projected solid prisms with grounded bases, separate wall depths, floor/window detail, key/fill shading, ground contact, depth fog, and roof visibility based on camera height. Buildings are not rotated PNG cutouts.
- Three facade textures are mapped onto those walls with bounded strips and cached mip levels. A second outer district is landscape-only. Original branded street furniture and airships remain.
- World-specific sky/surface palettes, world-locked asphalt grain, subdued lane markings, streaks, curb-light reflections, and existing bounded weather. Screen shake and jetpack flame flicker no longer call `Math.random()` in the renderer.
- Only existing coin entities are elevated, using stable world coordinates and nearby jump obstacles. No decorative coins, extra collectibles, new RNG draws, reward changes, or server modifications. **Dense five-coin arcs are deliberately not guaranteed**, as agreed with the user. Pickup remains the existing lane/depth rule, not a new height-sensitive rule.
- First pointer owns the gesture; short horizontal gestures are suppressed rather than treated as taps. A 6 px tap-jitter tolerance remains. Pointer capture handles releases outside the surface; lost capture/cancel clear ownership; release during pause also clears the session. Keyboard mapping and HUD pointer propagation protections remain unchanged.

## Asset audit and provenance

`asset-audit.json` records every proof-requested path, preload membership, and files retained outside the canvas preload. The latter are **not automatically unused**: some belong to DOM overlays/registry art and some are retained originals.

Reused without replacing bytes: rear run/idle/jump/fall/slide art, coins, obstacles, powerups, effects, props, city skyline and MPGR airship. No existing assets were deleted.

New assets, generated and inspected in small batches:

1. City + ice facade textures: orthographic material elevations, no sky/ground/text; each 512×768 WebP. Inspected before proceeding.
2. Desert facade: separate 512×768 material elevation, inspected.
3. Neutral road grain: separate 512×512 material, inspected.
4. Ice + desert atmospheric skyline replacements: new filenames, chroma-keyed offline, edge spill removed, inspected against a dark background and inside actual frames. Original panoramas remain on disk.

Facade/road textures are intentionally **opaque materials**, not cutout sprites. The replacement skylines have alpha. New filenames provide fresh cache identities without invalidating every existing asset. Nine unused side/sideMid/sideFar cutouts remain exported/on disk but are no longer downloaded by the live canvas preload. All live references decode and resolve. The preload remains large (~45.7 MB), predominantly inherited art; further loader/art-size work is outside this checkpoint.

An automatic cleanup of the old skyline was rejected after inspection because it damaged silhouettes. A candidate replacement slide pose was also rejected (cropped extremities/unsuitable proportions); it was not added to the repository. The existing slide art remains a limitation rather than being silently replaced with bad art.

## Visual evidence

- [Worlds: mobile and desktop](worlds.jpg)
- [Run, jump, slide, lane change and four stride frames](actions.jpg)

Proofs invoke the **actual `drawRunFrame`** with decoded production assets under a native Canvas implementation. They are not generated concept art or recording-context-only tests. Full outputs include 30 PNG frames (three worlds × two viewports × run/jump/fall/slide/lane), plus the sheets and asset audit. Fixtures deliberately place real entity types at selected depths for review; they are **not evidence of authoritative spawn density**. Client/replay parity is verified separately.

Reproduce without adding production dependencies or an authentication-bypass route:

```sh
npm install --prefix /tmp/mpgr-visual esbuild @napi-rs/canvas
MPGR_VISUAL_TOOLS=/tmp/mpgr-visual \
  node scripts/mpgr-run-visual-proof.mjs /tmp/mpgr-proofs --benchmark
```

These are renderer proofs, not browser screenshots or authenticated end-to-end gameplay. Browser automation could not be completed because the Chromium download failed in this environment.

## Verification

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | Pass, including final geometry change |
| MPGR Run relevant suite | **21 files / 178 tests passed** |
| Client → authoritative replay | **16 seeded runs passed**, with and without recorded controls; exact result equality |
| Input regressions | 10 classifier tests pass (short swipes, ownership, cancel, unmatched release, direction/tap semantics) |
| Render contracts | Grounding, revised responsive framing, depth order, world coverage, finite coordinates, stable head registration, texture bounds, bounded work, deterministic render/no simulation mutation |
| Asset references | All preload files exist/decode; material dimensions/size budgets checked; legacy files retained |
| Full `npm test` | **195 files / 2,068 assertions passed**, but command exits 1 due to an unhandled TLS `ECONNRESET` to `cca-lite.coinbase.com` from untouched AgentKit tests. Earlier run had four such network errors. Not reported as a clean suite exit. |
| `npm run lint` | 0 errors, 59 repository-wide warnings; no warnings in the new renderer/helper/script files |
| `npm run build` | Blocked by `next/font` failing to download Inter from `fonts.googleapis.com`; no unrelated font/config workarounds introduced |
| Browser/mobile hardware QA | **Not completed** |
| Performance gate | **Not passed**; see below |

### Performance — release blocker

The implementation bounds scenery, textures, particles and facade detail and caches mipmaps. It does not add a 3D engine. Nevertheless, the warm software-raster comparison regressed:

| Canvas | PR #62 renderer (median) | Current renderer (median) |
| --- | ---: | ---: |
| 390×844 | ~20 ms | ~54 ms |
| 1280×720 | ~48 ms | ~126 ms |

Same host/native Canvas, 25 frames, forced raster flush. The parent comparison used its renderer/assets/themes from `5489ea0`. These timings are **not phone/browser FPS measurements**, but are a substantive warning, not a green performance gate. `software-canvas-timing.json` records the final current-renderer sample. Mipmapping and reduced strip detail helped an earlier ~85 ms mobile result, but did not remove the regression.

Before merging: profile on representative low/mid-range phones and desktop browsers, reduce geometry/compositing cost with evidence, recheck at DPR 2, verify actual DOM HUD + keyboard/pointer integration, and rerun visual review. If the richer renderer cannot meet the budget, simplify/cachify its material/geometry pass before release rather than sacrificing input responsiveness.

## Remaining visual limitations

This is a substantial camera/architecture transformation, but **not yet a verified match for the cinematic reference**. The street still has repeated facade motifs; the inherited compact slide reads less naturally than a dedicated low slide; broad wet-road reflections and environmental composition need further art-direction review. No claim of photorealism or final mobile-game polish is made.

## Rollback / release safety

Keep this PR in draft until the above gates are satisfied. Do not modify or rewrite PR #62. Before merge, this branch can simply remain unmerged. After merge, revert this follow-up commit normally (never reset/force-push the parent branch). No API, schema, session protocol, input-trace version, economy migration, or existing-asset deletion is involved.
