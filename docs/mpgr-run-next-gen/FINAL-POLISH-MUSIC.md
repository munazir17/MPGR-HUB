# Final visual + music polish after `e8e44c1`

2026-09-27. **PR #63 only; still draft. PR #62 unchanged.** This is a small presentation/audio continuation, not a renderer/camera rewrite. Physical-device INP, audio playback and final art acceptance remain open; do not treat the native proof harness or mocked media tests as real-phone evidence.

## Preserved

- Rear camera, focal 300, horizon 0.54H, ground 0.84H, standing runner 0.165H across all worlds. No runner asset, registration, stride timing, jump/fall/slide selection or road projection changes.
- Existing painter queue, cached facade mipmaps, offline cutouts, isolated HUD clock, resize guard and opt-in diagnostics retained.
- Input classifier/handlers, simulation, physics, collisions, pickups, spawn authority/RNG, replay, scoring, rewards/XP/SP/economy, wallet and backend source unchanged. Existing 16 exact replay-parity cases and 10 input tests pass.

## Small visual changes

- Independently salted, deterministic left/right architectural profiles vary setback ratios, facade crops/window density and front-face shade. Rare landmark slots (~4.5% by fixed hash) use slightly wider/taller proportions, a distinct facade crop and a small rooftop service crown. No mirrored signage, new scenery entities or gameplay random draws. The existing number of upper volumes is preserved; crowns use two small unblurred rectangles.
- Street footprints/plinths and object/runner contact shadows use restrained world-appropriate tints. The runner has a tighter ambient footprint plus a small contact core which vanishes as the feet rise; feet position and animation are unchanged.
- Ice shoulders/fog are less white; existing ice reflections are shorter/fainter. Other road geometry, grain, lane marks, solid shoulders and perspective remain intact. No new image transforms or texture assets.
- Airship scale/motion retained, with slightly lower contrast for atmospheric depth. They are not removed.
- **Specific environment seam fixed:** the old transition overlay changed immediately from one world's fog colour to the next at the boundary. Three colour ramps are now cached once and sampled continuously across the transition. No per-frame colour-string allocation; existing fog duration/opacity is unchanged. This removes the abrupt overlay-colour switch, not every possible in-motion art limitation.

## Original local music

**Neon Circuit**: original 128 BPM synth instrumental with bass, arpeggios, pads and percussion. Sixteen bars / 30 seconds. Created offline from an included deterministic Python score, with no samples, commercial recordings, external music services or production dependencies.

- Asset: [`neon-circuit.wav`](../../public/games/mpgr-run/audio/neon-circuit.wav), 44.1 kHz mono PCM16, **2,646,044 bytes**.
- [CC0-1.0 dedication/provenance](../../public/games/mpgr-run/audio/LICENSE.md), [offline generator](../../scripts/mpgr-run-compose-music.py), [audio integrity audit](music-audit.json).
- Circular tail mixing, matched boundary samples and no codec delay/padding. Native `loop = true`; actual browser gaplessness still needs listening verification.
- One HTMLAudioElement, `preload="metadata"`, default volume **0.20**. No audio processing, timeupdate subscriptions, polling or React updates in the frame loop. Normal same-origin static-media requests are managed by the browser; no JS runtime downloader or external stream.
- Activation is requested inside the trusted Start click, before authentication awaits, and never awaited by game startup. Failed launches explicitly deactivate music even if React batches the temporary starting state. A rejected play promise or synchronous play failure is contained. Later real play-surface gestures retry when appropriate; pending/playing requests are deduplicated.
- Music pauses during game pause/game-over, hidden/page-hidden state and exit; disposal releases its media source/listeners. It resumes only when active, visible and enabled. Returning to a tab whose existing input hook auto-paused the game does **not** resume music until the game resumes.
- Compact ON/OFF control in the existing header, **outside the swipe surface**. It isolates its keyboard events from game hotkeys while preserving native Space/Enter button activation. Pointer activation clears button focus so subsequent keyboard lane controls are not trapped on the music control. Error/blocked state uses a compact indicator/title, not a growing banner that changes the running canvas height.
- Preference defaults ON and persists in best-effort namespaced localStorage, `mpgrhub:preferences:mpgr-run:music:v1`. No existing general audio-preference store was found. This key is separate from game/wallet statistics; denied storage is harmless.
- Existing SFX hooks are untouched (their default implementations remain no-ops). Music gain leaves headroom for registered SFX; this change does not add SFX.

## Fresh inspected proof sheets

- [City, ice and desert — mobile + desktop](worlds.jpg)
- [Actions and four stride poses](actions.jpg)
- [Run, jump, landing, left/centre/right, slide, obstacle, collectibles](states.jpg)
- [Immediately before/after all three world boundaries](transitions.jpg)

The harness generated **66 pose PNGs** (three worlds × two sizes × eleven states) plus six boundary renders in the transition sheet. The latter deliberately show the existing near-opaque transition fog, not normal gameplay. Worlds, states and transitions were inspected. They are actual native-Canvas renderer outputs, **not browser/HUD screenshots, physical-device recordings or authenticated gameplay**. Landing is a grounded fixture, not a continuous landing-animation recording. Final motion/art acceptance remains required; the inherited small slide silhouette was not replaced.

## Performance

Same-host sparse 25-frame native benchmark, forced raster flush, CSS-sized DPR1 surfaces; [recorded comparison](final-polish-timing.json):

| Revision | Mobile-sized 390×844 | Desktop-sized 1280×720 |
| --- | ---: | ---: |
| `e8e44c1`, fresh baseline | 23.25 ms | 43.87 ms |
| Final polish | **21.85 ms** | **41.96 ms** |
| Earlier reference reported for `e8e44c1` | 21.63 ms | 40.27 ms |

The final renderer remains near the requested range. An early candidate that forced extra upper volumes for landmarks measured 26.22 / 44.71 ms; the final version retains the original upper-volume count. Host variance also applies. **Music decoding/playback and actual phone FPS/INP are not measured by this renderer-only harness.** Music is structurally event-driven with no rAF work, but its device-level impact remains a hardware QA gate.

### Populated cross-check

Sequential grouped runs were noisy (including a city mobile comparison that changed substantially when run order was reversed). Both raw runs are retained in the timing JSON, not discarded. A paired follow-up shares decoded images, uses separate canvases, warms both paths for eight frames, and alternates order across **50 matched frame pairs** for each world/size. Median paired after/before ratios were **0.988–1.000** across all six cases: no material added render cost detected by that check. Absolute populated native times are higher than the sparse table and must not be presented as the same workload or phone FPS. Music playback is absent from both harnesses.

## Verification

| Gate | Result |
| --- | --- |
| TypeScript | `npm run typecheck`, exit 0 |
| Run tests | **25 files / 209 tests**, exit 0 |
| Replay/input | Existing 16 exact seeded parity cases and 10 input tests pass |
| Music/control tests | **12 tests**: local asset, metadata/volume/loop configuration, immediate activation, request deduplication, phase/visibility pause/resume, persisted mute, rejection/throw/storage/media failures, exit cleanup, subscriber cleanup, keyboard isolation, PCM duration/peak/seam/license |
| Fog continuity | Both sides of every boundary match; ramps join adjacent palettes |
| Full suite | **199 files / 2,099 tests passed, exit 0** |
| Lint | Exit 0; **0 errors / 59 existing repository warnings** |
| Asset references | Existing sprite references decode in fresh proofs; offline cutout verification passes; new WAV/header/license checks pass |
| Build | **Exit 1**: Google Fonts Inter download failure in `next/font`; no unrelated font/network bypass |
| Physical device / audible browser playback | **Not verified**: no accessible device; available Chromium still lacks NSS/NSPR system libraries. Mocked media tests do not prove browser autoplay policy, sound output or audible loop continuity. |

The first full run exposed an existing diagnostic test's exact floating-point equality (`168` versus `168.00000000000003`). That test now uses an appropriately tight numeric tolerance; diagnostic runtime values and INP warnings are unchanged. The final complete rerun passed.

## Required device follow-up

Use the normal authenticated game, optionally `?runPerf=1`, without bypassing auth or gameplay:

1. Start with fresh preferences; confirm music activation after Start. Let it cross 30s and 60s, listening for any loop gap/click.
2. Pause/resume, hide/show the tab, leave/return to the game. Confirm no overlap, playback while paused, or sound after exit.
3. Toggle OFF/ON with touch and keyboard; reload to verify OFF persistence. Confirm no jump/lane input from the music button.
4. Exercise autoplay denial/media failure and verify gameplay continues; retry from a user gesture.
5. Compare music ON/OFF on the affected device while capturing left/right/jump/slide/rapid lane changes and pause/resume with the existing timing report and a browser Performance trace.

**The previously reported ~273 ms INP is still not conclusively attributed or verified fixed.** No warning was hidden. Do not mark the entire release gate green based on these native or unit-test results.
