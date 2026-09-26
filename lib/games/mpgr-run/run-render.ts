/**
 * MPGR Run — canvas rendering. Extracted verbatim from RunGame.tsx
 * (P2-11 follow-up modularization): stripBackgroundToTransparent, the
 * COLORS / OBSTACLE_COLOR palettes, and the frame-render logic (formerly
 * the `draw` useCallback body) never read component state, refs, or props
 * directly — they only ever touched the canvas 2D context, a World
 * snapshot, and the getSprite() lookup, all three of which are now
 * explicit parameters. This is a literal relocation with no behavior
 * change: same statements, same order, same values.
 */
import { MPGR_RUN_SIMULATION_WIDTH } from "@/lib/games/mpgr-run/authoritative-replay";
import {
  CHARACTER_SPRITES,
  CHARACTER_REAR_SPRITES,
  REAR_RUN_CYCLE,
  OBSTACLE_SPRITES,
  COLLECTIBLE_SPRITES,
  POWERUP_SPRITES,
  CHECKPOINT_SPRITE,
  CITY_ENVIRONMENT,
} from "@/lib/games/mpgr-run/run-assets";
import {
  LANE_GAP_PX,
  PLAYER_X,
  PLAYER_SIZE,
  MAGNET_ATTRACT_MS,
  COLLECTIBLE_TYPES,
  POWERUP_TYPES,
} from "@/lib/games/mpgr-run/run-config";
import { clamp } from "@/lib/games/mpgr-run/run-physics";
import type { ObstacleEntity } from "@/lib/games/mpgr-run/spawn-manager";
import type { World } from "@/lib/games/mpgr-run/run-world";

/**
 * Removes a baked-in solid (or near-solid) background from an asset that
 * has no real alpha channel, via a flood fill seeded from all four edges —
 * NOT a blanket color match. That distinction matters: a genuinely dark
 * interior detail (a boot, a chest's iron trim, a checkpoint flag's black
 * outline) is surrounded by non-background pixels on every side, so the
 * fill never reaches it and it survives untouched; only background that's
 * actually connected to the border gets cleared. Runs once per asset (see
 * BACKGROUND_STRIP_TARGETS in run-assets.ts) and the resulting canvas is
 * cached — never re-run per frame.
 */
export function stripBackgroundToTransparent(img: HTMLImageElement, tolerance = 26): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx || width === 0 || height === 0) return canvas;

  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  const toleranceSq = tolerance * tolerance;

  const seed = 0;
  const bgR = data[seed];
  const bgG = data[seed + 1];
  const bgB = data[seed + 2];
  const matchesBackground = (i: number): boolean => {
    const dr = data[i] - bgR;
    const dg = data[i + 1] - bgG;
    const db = data[i + 2] - bgB;
    return dr * dr + dg * dg + db * db <= toleranceSq;
  };

  const visited = new Uint8Array(width * height);
  const stackX: number[] = [];
  const stackY: number[] = [];
  for (let x = 0; x < width; x++) {
    stackX.push(x, x);
    stackY.push(0, height - 1);
  }
  for (let y = 0; y < height; y++) {
    stackX.push(0, width - 1);
    stackY.push(y, y);
  }

  while (stackX.length > 0) {
    const x = stackX.pop() as number;
    const y = stackY.pop() as number;
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const p = y * width + x;
    if (visited[p]) continue;
    const i = p * 4;
    if (!matchesBackground(i)) continue;
    visited[p] = 1;
    data[i + 3] = 0;
    stackX.push(x + 1, x - 1, x, x);
    stackY.push(y, y, y + 1, y - 1);
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

const COLORS = {
  bg: "#0A0B0D",
  laneLine: "#3B82F6",
  player: "#60A5FA",
  playerCore: "#3B82F6",
};

const OBSTACLE_COLOR: Record<ObstacleEntity["type"], { fill: string; dark: string }> = {
  spikes: { fill: "#F87171", dark: "#7F1D1D" },
  crate: { fill: "#F0B90B", dark: "#92600A" },
  tnt: { fill: "#FB923C", dark: "#7C2D12" },
  saw: { fill: "#E5E7EB", dark: "#4B5563" },
  drone: { fill: "#A78BFA", dark: "#4C1D95" },
  barrier: { fill: "#38BDF8", dark: "#0C4A6E" },
};


/** Natural aspect of the city parallax artwork (1536x1024 source files). */
const RUN_CITY_ART_ASPECT = 1536 / 1024;

/**
 * Uniform gameplay scale for the responsive renderer.
 *
 * The simulation is untouched: the world is 960 units wide, entities
 * spawn at x=960, and the authoritative replay verifies every collision
 * in those fixed units. Rendering uses ONE uniform scale so the player,
 * obstacles, collectibles and hitboxes all grow together with the
 * viewport — no anisotropic stretch, no thin sprites on phones:
 *
 *   - desktop/tablet: u = viewportWidth / 960 shows the FULL simulation
 *     width (cropping the field would cut reaction time — a gameplay
 *     change, not a layout one), scaled up as big as the screen allows;
 *   - phones (below RUN_MIN_VIEW_SCALE * 960 css px): the scale is
 *     floored so gameplay objects stay clearly visible; the classic
 *     side view crops correspondingly behind the spawn edge via
 *     runCameraOffsetX(), while the rear view keeps the full track
 *     width proportional (lane gap is a fraction of the design width);
 *   - ultrawide: capped so the game never gets absurd.
 *
 * The rear-camera renderer uses this same u as its single master scale,
 * so the runner, hazards and collectibles still grow together with the
 * viewport exactly as the locked responsive-scaling tests require.
 */
export const RUN_MIN_VIEW_SCALE = 0.75;
export const RUN_MAX_VIEW_SCALE = 2.4;

export function runViewScale(viewportWidth: number): number {
  return clamp(
    viewportWidth / MPGR_RUN_SIMULATION_WIDTH,
    RUN_MIN_VIEW_SCALE,
    RUN_MAX_VIEW_SCALE,
  );
}

/**
 * Left edge of the visible camera window, in simulation x units — the
 * CLASSIC side-view framing contract, kept verbatim (and covered by
 * run-view-scale.test.ts) for the side-view presentation and any future
 * classic-mode toggle.
 *
 * The rear-camera renderer (drawRunFrame below) does not crop the field
 * horizontally at all: simulation x is depth there, and perspective
 * compression toward the horizon gives narrow screens their warning
 * time instead of a camera window, so this offset is intentionally not
 * applied to the rear view.
 *
 *   - full field visible (u = w/960, uncapped): 0 — identical framing
 *     to the classic renderer;
 *   - zoomed past the whole field (u capped on ultrawide): the window
 *     is right-anchored at the spawn edge (960) so entities never pop
 *     in mid-screen, and the extra width shows more road behind the
 *     player;
 *   - cropped (narrow screens): keep a short run-up behind the player
 *     and crop ahead, never past the spawn edge.
 */
export function runCameraOffsetX(viewportWidth: number): number {
  const visible = viewportWidth / runViewScale(viewportWidth);
  if (visible >= MPGR_RUN_SIMULATION_WIDTH) {
    return MPGR_RUN_SIMULATION_WIDTH - visible; // <= 0, right-anchored
  }
  const playerX = MPGR_RUN_SIMULATION_WIDTH * PLAYER_X;
  const runUp = 110; // sim units of road kept visible behind the player
  return Math.max(0, Math.min(playerX - runUp, MPGR_RUN_SIMULATION_WIDTH - visible));
}

/**
 * Renders one frame of MPGR Run onto `ctx` — Subway-Surfers-style
 * THIRD-PERSON REAR CAMERA over the untouched side-scroll simulation.
 *
 * The simulation (and the server's authoritative replay) still scrolls
 * entities along a fixed 960-unit depth axis with 3 logical lanes and a
 * vertical jump height. This renderer maps those world coordinates onto a
 * perspective ground plane behind the runner:
 *
 *   depth   z  = entity.x - PLAYER_X*960          (0 at the player, +ahead)
 *   scale   s  = FOCAL / (FOCAL + z)              (1 at the player, →0 at horizon)
 *   ground  y  = horizonY + (groundY - horizonY) * s   (track converges)
 *   lateral x  = centreX - camLat + laneLat * s   (lanes converge too)
 *   height  y -= worldHeight * s                  (jumps/elevations)
 *
 * Everything therefore shrinks toward a single vanishing point, objects
 * grow as they approach, and the player is seen from BEHIND (rear sprite
 * set) standing on the near end of the track. Painter's algorithm: a
 * single depth-sorted draw list, player included at z = 0, so hazards
 * passing the player sweep in front of the camera naturally.
 *
 * Signature mirrors exactly what the original inline `draw` useCallback
 * closed over: a 2D context, the current World snapshot, the viewport
 * size, and the sprite lookup. Nothing else.
 */
export function drawRunFrame(
  ctx: CanvasRenderingContext2D,
  world: World,
  viewportWidth: number,
  height: number,
  getSprite: (src: string) => CanvasImageSource | null
): void {
  const p = world.player;

  // ONE uniform gameplay scale (see runViewScale) — the whole rear view is
  // laid out in design units (css px / u) so phones and desktops frame the
  // same track proportionally.
  const u = runViewScale(viewportWidth);
  const W = viewportWidth / u;
  const H = height / u;

  // --- Rear-camera projection ------------------------------------------
  const playerDepthX = MPGR_RUN_SIMULATION_WIDTH * PLAYER_X;
  const HORIZON_Y = H * 0.36; // vanishing line
  const GROUND_Y = H * 0.82; // track surface at the player's depth
  const FOCAL = 220; // depth (sim units) at which scale halves
  const Z_FAR = 860; // draw distance ahead of the player
  const S_MAX = 2.6; // near clip (s beyond this is behind the camera)

  const sOf = (z: number): number => FOCAL / (FOCAL + z);
  const groundYAt = (s: number): number => HORIZON_Y + (GROUND_Y - HORIZON_Y) * s;

  // Lateral layout: the 3-lane track spans ~55% of the design width at the
  // player's depth, on any viewport (responsive, never hardcoded per device).
  const laneGap = W * 0.18333;
  const trackHalf = laneGap * 1.5;
  const K = laneGap / LANE_GAP_PX; // sim lane-offset units -> world lateral units
  const laneLat = (lane: number): number => (lane - 1) * laneGap;
  const playerLat = p.laneOffset * K; // smoothed, same glide as before
  const camLat = playerLat * 0.3; // camera trails the lane change slightly
  const xAt = (lat: number, s: number): number => W / 2 - camLat + lat * s;

  const spriteAspect = (img: CanvasImageSource): number => {
    const probe = img as Partial<HTMLImageElement> & Partial<HTMLCanvasElement>;
    const w = probe.naturalWidth ?? probe.width ?? 0;
    const h = probe.naturalHeight ?? probe.height ?? 0;
    return w > 0 && h > 0 ? w / h : 1;
  };

  ctx.save();
  ctx.scale(u, u);
  if (world.screenShake > 0.5) {
    ctx.translate((Math.random() - 0.5) * world.screenShake, (Math.random() - 0.5) * world.screenShake);
  }
  ctx.clearRect(-40, -40, W + 80, H + 80);

  // --- Sky ---------------------------------------------------------------
  const skyGradient = ctx.createLinearGradient(0, 0, 0, HORIZON_Y + 20);
  skyGradient.addColorStop(0, "#0A0B0D");
  skyGradient.addColorStop(0.55, "#0D1420");
  skyGradient.addColorStop(1, "#16233A");
  ctx.fillStyle = skyGradient;
  ctx.fillRect(-40, -40, W + 80, HORIZON_Y + 60);

  // --- City skyline on the horizon (real parallax art, distance-banded) ---
  const cityBg = getSprite(CITY_ENVIRONMENT.background);
  const cityMid = getSprite(CITY_ENVIRONMENT.midground);
  const cityFg = getSprite(CITY_ENVIRONMENT.foreground);
  const cityReady = !!(cityBg && cityMid && cityFg);
  if (cityReady && cityBg && cityMid && cityFg) {
    const layers: Array<[CanvasImageSource, number, number, number]> = [
      [cityBg, 0.46, 0.5, 0.1],
      [cityMid, 0.66, 0.68, 0.2],
      [cityFg, 0.92, 0.85, 0.34],
    ];
    for (const [img, bandFrac, alpha, camFactor] of layers) {
      const bandH = HORIZON_Y * bandFrac;
      const layerW = bandH * RUN_CITY_ART_ASPECT;
      // Lateral camera parallax only — the skyline sits at infinity along
      // the running direction, so forward scroll must not slide it sideways.
      const offset = ((camLat * camFactor) % layerW + layerW) % layerW;
      ctx.globalAlpha = alpha;
      for (let x = -offset - layerW; x < W + layerW; x += layerW) {
        ctx.drawImage(img, x, HORIZON_Y - bandH + 2, layerW, bandH);
      }
      ctx.globalAlpha = 1;
    }
  } else {
    // Procedural skyline fallback until the city set is decode-ready.
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = "#3B82F6";
    const gap = 90;
    const drift = (camLat * 0.2) % gap;
    for (let bx = -drift - gap; bx < W + gap; bx += gap) {
      const bh = HORIZON_Y * (0.3 + ((Math.floor(bx / gap) % 3) + 2) * 0.12);
      ctx.fillRect(bx, HORIZON_Y - bh, gap * 0.45, bh);
    }
    ctx.globalAlpha = 1;
  }
  // Distance haze softening the skyline bases into the track.
  const haze = ctx.createLinearGradient(0, HORIZON_Y - H * 0.09, 0, HORIZON_Y + 4);
  haze.addColorStop(0, "rgba(13,20,32,0)");
  haze.addColorStop(1, "rgba(13,20,32,0.92)");
  ctx.fillStyle = haze;
  ctx.fillRect(-40, HORIZON_Y - H * 0.09, W + 80, H * 0.09 + 8);

  // --- Ground plane -------------------------------------------------------
  const groundGradient = ctx.createLinearGradient(0, HORIZON_Y, 0, H);
  groundGradient.addColorStop(0, "#0B0F16");
  groundGradient.addColorStop(0.35, "#0D1219");
  groundGradient.addColorStop(1, "#08090C");
  ctx.fillStyle = groundGradient;
  ctx.fillRect(-40, HORIZON_Y, W + 80, H - HORIZON_Y + 40);

  const sNear = S_MAX;
  const sFar = sOf(Z_FAR);

  // Track trapezoid (converges to the vanishing point). Plain ctx paths
  // (no Path2D) so the frame also renders under minimal canvas stubs.
  const traceTrack = () => {
    ctx.beginPath();
    ctx.moveTo(xAt(-trackHalf, sNear), groundYAt(sNear));
    ctx.lineTo(xAt(trackHalf, sNear), groundYAt(sNear));
    ctx.lineTo(xAt(trackHalf, sFar), groundYAt(sFar));
    ctx.lineTo(xAt(-trackHalf, sFar), groundYAt(sFar));
    ctx.closePath();
  };
  traceTrack();
  const asphalt = ctx.createLinearGradient(0, groundYAt(sFar), 0, groundYAt(Math.min(sNear, 1.4)));
  asphalt.addColorStop(0, "#141B26");
  asphalt.addColorStop(1, "#1B2432");
  ctx.fillStyle = asphalt;
  ctx.fill();

  // World-locked scrolling texture inside the track: cross stripes + lane
  // dashes tied to traveledPx, so the ground rushes toward the camera at
  // exactly the entities' speed and freezes correctly on pause.
  const STRIPE_SPACING = 120;
  const STRIPE_THICK = 26;
  const stripeResidue =
    ((-world.traveledPx - playerDepthX) % STRIPE_SPACING + STRIPE_SPACING) % STRIPE_SPACING;
  ctx.save();
  traceTrack();
  ctx.clip();
  for (let z = stripeResidue - STRIPE_SPACING; z < Z_FAR; z += STRIPE_SPACING) {
    const zA = Math.max(z, -135);
    const zB = z + STRIPE_THICK;
    if (zB <= -135) continue;
    const sA = sOf(zA);
    const sB = sOf(zB);
    const fade = 1 - Math.max(0, z) / Z_FAR;
    ctx.globalAlpha = 0.05 + fade * 0.1;
    ctx.fillStyle = COLORS.laneLine;
    ctx.beginPath();
    ctx.moveTo(xAt(-trackHalf, sA), groundYAt(sA));
    ctx.lineTo(xAt(trackHalf, sA), groundYAt(sA));
    ctx.lineTo(xAt(trackHalf, sB), groundYAt(sB));
    ctx.lineTo(xAt(-trackHalf, sB), groundYAt(sB));
    ctx.closePath();
    ctx.fill();
    // Lane divider dashes ride the same scroll phase.
    ctx.globalAlpha = 0.1 + fade * 0.35;
    for (const side of [-0.5, 0.5]) {
      const lat = laneGap * side;
      ctx.beginPath();
      ctx.moveTo(xAt(lat - 1.6, sA), groundYAt(sA));
      ctx.lineTo(xAt(lat + 1.6, sA), groundYAt(sA));
      ctx.lineTo(xAt(lat + 1.6, sB), groundYAt(sB));
      ctx.lineTo(xAt(lat - 1.6, sB), groundYAt(sB));
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  // Glowing outer rails.
  const railGradient = ctx.createLinearGradient(0, groundYAt(sFar), 0, groundYAt(Math.min(sNear, 1.5)));
  railGradient.addColorStop(0, "rgba(59,130,246,0.05)");
  railGradient.addColorStop(1, "rgba(59,130,246,0.75)");
  ctx.fillStyle = railGradient;
  for (const side of [-1, 1]) {
    const inner = trackHalf * side;
    const outer = (trackHalf + 3) * side;
    ctx.beginPath();
    ctx.moveTo(xAt(inner, sNear), groundYAt(sNear));
    ctx.lineTo(xAt(outer, sNear), groundYAt(sNear));
    ctx.lineTo(xAt(outer, sFar), groundYAt(sFar));
    ctx.lineTo(xAt(inner, sFar), groundYAt(sFar));
    ctx.closePath();
    ctx.fill();
  }

  // --- Checkpoint flash (screen-space, unchanged behaviour) ---------------
  if (world.elapsedMs < world.checkpointFlashUntilMs) {
    const elapsedSinceStart = 1400 - (world.checkpointFlashUntilMs - world.elapsedMs);
    const remaining = (world.checkpointFlashUntilMs - world.elapsedMs) / 1400;
    const flashAlpha = clamp(remaining, 0, 1);
    ctx.globalAlpha = flashAlpha * 0.5;
    ctx.fillStyle = "#FBBF24";
    ctx.fillRect(-40, -40, W + 80, H + 80);
    ctx.globalAlpha = 1;

    const checkpointImg = getSprite(CHECKPOINT_SPRITE);
    if (checkpointImg) {
      const growT = clamp(elapsedSinceStart / 260, 0, 1);
      const easedGrow = 1 - Math.pow(1 - growT, 3);
      const baseSize = Math.min(W, H) * 0.28;
      const size = baseSize * (0.7 + easedGrow * 0.3);
      const cx = W / 2;
      const cy = H * 0.22;
      const ringT = clamp(elapsedSinceStart / 700, 0, 1);
      ctx.globalAlpha = (1 - ringT) * 0.5;
      ctx.strokeStyle = "#FBBF24";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx, cy, baseSize * 0.4 + ringT * baseSize * 0.6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = flashAlpha;
      ctx.drawImage(checkpointImg, cx - size / 2, cy - size / 2, size, size);
      ctx.globalAlpha = 1;
    }
  }

  // --- Depth-sorted world items (painter's algorithm) ---------------------
  interface DrawItem {
    z: number;
    draw: () => void;
  }
  const items: DrawItem[] = [];

  const drawGroundShadow = (sx: number, gy: number, rx: number, alpha: number) => {
    if (alpha <= 0.01 || rx <= 0.5) return;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = "#000000";
    ctx.beginPath();
    ctx.ellipse(sx, gy, rx, rx * 0.32, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  };

  const visibleScale = (z: number): number | null => {
    if (z > Z_FAR || z < -135) return null;
    const s = sOf(z);
    return s > S_MAX ? null : s;
  };

  // Power-ups.
  for (const pu of world.powerups) {
    if (pu.collected) continue;
    const z = pu.x - playerDepthX;
    const s = visibleScale(z);
    if (s === null) continue;
    const cfg = POWERUP_TYPES[pu.type];
    items.push({
      z,
      draw: () => {
        const bob = Math.sin(world.elapsedMs / 260 + pu.id) * 5;
        const sx = xAt(laneLat(pu.lane), s);
        const gy = groundYAt(s);
        const cy = gy - (20 + bob) * s;
        const size = pu.radius * 3.0 * s;
        drawGroundShadow(sx, gy, size * 0.4, 0.28 * s);
        const puImg = getSprite(POWERUP_SPRITES[pu.type]);
        ctx.shadowColor = cfg.color;
        ctx.shadowBlur = 12 * s;
        if (puImg) {
          ctx.drawImage(puImg, sx - size / 2, cy - size / 2, size, size);
        } else {
          ctx.beginPath();
          ctx.arc(sx, cy, (pu.radius * s), 0, Math.PI * 2);
          ctx.fillStyle = cfg.color;
          ctx.fill();
          ctx.strokeStyle = "rgba(255,255,255,0.85)";
          ctx.lineWidth = 1.5 * s;
          ctx.stroke();
        }
        ctx.shadowBlur = 0;
      },
    });
  }

  // Collectibles.
  const playerCenterX = xAt(playerLat, 1);
  // Visual heights (world units): standing runner reads ~2.4x the 30-unit
  // hitbox; the slide pose is a low bundle that stays under the drone line
  // (groundHeight 42) so "slide under" reads correctly. Hitboxes themselves
  // are untouched — this is sprite-box sizing only.
  const playerHeightWorld = p.sliding ? PLAYER_SIZE * 1.3 : PLAYER_SIZE * 2.4;
  const playerCenterY = GROUND_Y - p.playerY - playerHeightWorld / 2;
  for (const c of world.collectibles) {
    if (c.collected) continue;
    const z = c.x - playerDepthX;
    const s = visibleScale(z);
    if (s === null) continue;
    const color = COLLECTIBLE_TYPES[c.type].color;
    items.push({
      z,
      draw: () => {
        const bob = Math.sin(world.elapsedMs / 300 + c.id) * 6;
        const attracting = c.magnetizedAtMs !== undefined;
        const shrink = attracting
          ? clamp(1 - (world.elapsedMs - (c.magnetizedAtMs as number)) / MAGNET_ATTRACT_MS, 0.25, 1)
          : 1;
        const sx = xAt(laneLat(c.lane), s);
        const gy = groundYAt(s);
        const cy = gy - (14 + bob) * s;
        const size = c.radius * 2.9 * shrink * s;
        drawGroundShadow(sx, gy, size * 0.42, 0.3 * s);
        const cImg = getSprite(COLLECTIBLE_SPRITES[c.type]);
        ctx.shadowColor = color;
        ctx.shadowBlur = 8 * s;
        if (cImg) {
          ctx.drawImage(cImg, sx - size / 2, cy - size / 2, size, size);
        } else {
          ctx.beginPath();
          ctx.arc(sx, cy, c.radius * shrink * s, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          ctx.strokeStyle = "rgba(255,255,255,0.6)";
          ctx.lineWidth = 1 * s;
          ctx.stroke();
        }
        ctx.shadowBlur = 0;
        if (attracting) {
          ctx.strokeStyle = "rgba(34,211,238,0.5)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(sx, cy);
          ctx.lineTo(playerCenterX, playerCenterY);
          ctx.stroke();
        }
      },
    });
  }

  // Obstacles.
  for (const o of world.obstacles) {
    const z = o.x + o.width / 2 - playerDepthX;
    const s = visibleScale(z);
    if (s === null) continue;
    const palette = OBSTACLE_COLOR[o.type];
    items.push({
      z,
      draw: () => {
        const sx = xAt(laneLat(o.lane), s);
        const gy = groundYAt(s);
        const wW = o.width * 1.5 * s;
        const hW = (o.height + o.groundHeight + 8) * s;
        const bottom = gy - o.groundHeight * s;
        drawGroundShadow(sx, gy, wW * 0.42, 0.38 * s);
        const oImg = getSprite(OBSTACLE_SPRITES[o.type]);
        ctx.save();
        if (o.type === "saw") {
          const cy = bottom - hW / 2;
          ctx.translate(sx, cy);
          ctx.rotate(world.elapsedMs / 120);
          ctx.translate(-sx, -cy);
        }
        ctx.globalAlpha = o.hit ? 0.55 : 1;
        if (oImg) {
          ctx.shadowColor = palette.fill;
          ctx.shadowBlur = o.hit ? 0 : 6 * s;
          ctx.drawImage(oImg, sx - wW / 2, bottom - hW, wW, hW);
          ctx.shadowBlur = 0;
        } else {
          const top = bottom - hW;
          const gradient = ctx.createLinearGradient(0, top, 0, bottom);
          gradient.addColorStop(0, palette.fill);
          gradient.addColorStop(1, palette.dark);
          ctx.fillStyle = gradient;
          ctx.shadowColor = palette.fill;
          ctx.shadowBlur = o.hit ? 0 : 6 * s;
          ctx.fillRect(sx - wW / 2, top, wW, hW);
          ctx.shadowBlur = 0;
        }
        ctx.globalAlpha = 1;
        ctx.restore();
      },
    });
  }

  // The runner — rear view, z = 0, feet planted on the near track surface.
  items.push({
    z: 0,
    draw: () => {
      const sx = xAt(playerLat, 1);
      const bottom = GROUND_Y - p.playerY; // exact grounding: playerY == 0 -> feet on track
      const drawH = playerHeightWorld;
      const invulnerable = world.elapsedMs < p.invulnerableUntilMs;
      const shielded = !!world.activePowerups.shield || !!world.activePowerups.invincibility;
      const jetpackActiveNow = !!world.activePowerups.jetpack;

      // Contact shadow keeps the runner visually glued to the track.
      const airFactor = clamp(1 - p.playerY / 320, 0.25, 1);
      drawGroundShadow(sx, GROUND_Y, drawH * 0.34 * airFactor, 0.42 * airFactor + 0.06);

      if (shielded) {
        ctx.beginPath();
        ctx.arc(sx, bottom - drawH / 2, PLAYER_SIZE * 0.9, 0, Math.PI * 2);
        ctx.strokeStyle = world.activePowerups.invincibility ? "#F472B6" : "#34D399";
        ctx.globalAlpha = 0.6 + Math.sin(world.elapsedMs / 90) * 0.2;
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (jetpackActiveNow) {
        // Downward flicker flame under the feet (rear view).
        for (let layer = 0; layer < 2; layer++) {
          const flicker = Math.random() * 8;
          const len = 14 + layer * 8 + flicker;
          ctx.beginPath();
          ctx.moveTo(sx - 7, bottom - 2 + layer * 2);
          ctx.lineTo(sx, bottom + len);
          ctx.lineTo(sx + 7, bottom - 2 + layer * 2);
          ctx.closePath();
          ctx.fillStyle = layer === 0 ? "#FDE68A" : "#FB923C";
          ctx.shadowColor = "#FB923C";
          ctx.shadowBlur = 14 - layer * 4;
          ctx.globalAlpha = 0.85 - layer * 0.2;
          ctx.fill();
        }
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
      }

      ctx.globalAlpha = invulnerable && !shielded ? 0.4 + Math.sin(world.elapsedMs / 60) * 0.3 : 1;

      let spriteSrc: string;
      if (world.elapsedMs < 1) spriteSrc = CHARACTER_REAR_SPRITES.idle;
      else if (jetpackActiveNow) spriteSrc = CHARACTER_REAR_SPRITES.jump;
      else if (p.sliding) spriteSrc = CHARACTER_REAR_SPRITES.slide;
      else if (p.playerY > 0)
        spriteSrc = p.velocityY > 0 ? CHARACTER_REAR_SPRITES.jump : CHARACTER_REAR_SPRITES.fall;
      else spriteSrc = REAR_RUN_CYCLE[Math.floor(world.elapsedMs / 110) % REAR_RUN_CYCLE.length];
      let playerImg = getSprite(spriteSrc);
      if (!playerImg) {
        playerImg =
          getSprite(CHARACTER_REAR_SPRITES.run1) ??
          getSprite(CHARACTER_REAR_SPRITES.idle) ??
          getSprite(CHARACTER_SPRITES.run);
      }

      if (playerImg) {
        const aspect = spriteAspect(playerImg);
        const drawW = drawH * aspect;
        // Speed boost: ghost copies trailing toward the camera.
        if (world.activePowerups.speed) {
          for (const [gz, ga] of [
            [-16, 0.16],
            [-32, 0.09],
          ] as const) {
            const gs = sOf(gz);
            if (gs <= S_MAX) {
              ctx.globalAlpha = ga;
              const gH = drawH * gs;
              const gW = gH * aspect;
              ctx.drawImage(
                playerImg,
                xAt(playerLat, gs) - gW / 2,
                groundYAt(gs) - p.playerY * gs - gH,
                gW,
                gH
              );
            }
          }
          ctx.globalAlpha = invulnerable && !shielded ? 0.4 + Math.sin(world.elapsedMs / 60) * 0.3 : 1;
        }
        ctx.save();
        ctx.translate(sx, bottom - drawH / 2);
        if (jetpackActiveNow) ctx.rotate(0.06);
        ctx.shadowColor = "rgba(59,130,246,0.55)";
        ctx.shadowBlur = 14;
        ctx.drawImage(playerImg, -drawW / 2, -drawH / 2, drawW, drawH);
        ctx.shadowBlur = 0;
        ctx.restore();
      } else {
        // Procedural capsule fallback (rear silhouette: hood + head block).
        const playerTop = bottom - drawH;
        const grad = ctx.createLinearGradient(0, playerTop, 0, bottom);
        grad.addColorStop(0, COLORS.player);
        grad.addColorStop(1, COLORS.playerCore);
        ctx.fillStyle = grad;
        ctx.shadowColor = "rgba(59,130,246,0.55)";
        ctx.shadowBlur = 14;
        const pw = drawH * 0.42;
        const pr = 7;
        ctx.beginPath();
        ctx.moveTo(sx - pw / 2 + pr, playerTop);
        ctx.lineTo(sx + pw / 2 - pr, playerTop);
        ctx.quadraticCurveTo(sx + pw / 2, playerTop, sx + pw / 2, playerTop + pr);
        ctx.lineTo(sx + pw / 2, bottom - pr);
        ctx.quadraticCurveTo(sx + pw / 2, bottom, sx + pw / 2 - pr, bottom);
        ctx.lineTo(sx - pw / 2 + pr, bottom);
        ctx.quadraticCurveTo(sx - pw / 2, bottom, sx - pw / 2, bottom - pr);
        ctx.lineTo(sx - pw / 2, playerTop + pr);
        ctx.quadraticCurveTo(sx - pw / 2, playerTop, sx - pw / 2 + pr, playerTop);
        ctx.closePath();
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = "#FCD34D"; // hair block, seen from behind
        ctx.fillRect(sx - pw * 0.32, playerTop + drawH * 0.04, pw * 0.64, drawH * 0.2);
      }
      ctx.globalAlpha = 1;
    },
  });

  items.sort((a, b) => b.z - a.z);
  for (const item of items) item.draw();

  // --- Particles & sprite bursts (world-space sparks, projected) ----------
  for (const part of world.particles) {
    const z = part.x - playerDepthX;
    const s = visibleScale(z);
    if (s === null) continue;
    const alpha = clamp(part.life / part.maxLife, 0, 1);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = part.color;
    ctx.beginPath();
    ctx.arc(
      xAt(laneLat(part.lane) + part.lx, s),
      groundYAt(s) - part.y * s,
      Math.max(0.6, part.size * s),
      0,
      Math.PI * 2
    );
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  for (const burst of world.spriteBursts) {
    const img = getSprite(burst.sprite);
    if (!img) continue;
    const z = burst.x - playerDepthX;
    const s = visibleScale(z);
    if (s === null) continue;
    const t = clamp((world.elapsedMs - burst.startMs) / burst.durationMs, 0, 1);
    const size = burst.maxSize * (0.5 + t * 0.6) * s;
    ctx.globalAlpha = 1 - t;
    ctx.drawImage(
      img,
      xAt(laneLat(burst.lane), s) - size / 2,
      groundYAt(s) - burst.y * s - size / 2,
      size,
      size
    );
  }
  ctx.globalAlpha = 1;

  // --- Cinematic vignette + hit flash (screen space, unchanged) -----------
  const vignette = ctx.createRadialGradient(
    W / 2,
    H / 2,
    Math.min(W, H) * 0.35,
    W / 2,
    H / 2,
    Math.max(W, H) * 0.7
  );
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,0.38)");
  ctx.fillStyle = vignette;
  ctx.fillRect(-40, -40, W + 80, H + 80);

  if (world.elapsedMs < world.hitFlashUntilMs) {
    const hitT = clamp((world.hitFlashUntilMs - world.elapsedMs) / 220, 0, 1);
    ctx.globalAlpha = hitT * 0.35;
    ctx.fillStyle = "#DC2626";
    ctx.fillRect(-40, -40, W + 80, H + 80);
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}
