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
  OBSTACLE_SPRITES,
  COLLECTIBLE_SPRITES,
  POWERUP_SPRITES,
  CHECKPOINT_SPRITE,
  CITY_ENVIRONMENT,
} from "@/lib/games/mpgr-run/run-assets";
import {
  LANE_COUNT,
  LANE_CENTER_Y,
  PLAYER_X,
  PLAYER_SIZE,
  SLIDE_HITBOX_SCALE,
  MAGNET_ATTRACT_MS,
  COLLECTIBLE_TYPES,
  POWERUP_TYPES,
} from "@/lib/games/mpgr-run/run-config";
import { clamp, laneBaselineScreenY } from "@/lib/games/mpgr-run/run-physics";
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


/**
 * Renders one frame of MPGR Run onto `ctx`.
 *
 * Signature mirrors exactly what the original inline `draw` useCallback
 * closed over once its own canvas/context/size guard clauses (which stay
 * in RunGame.tsx, since they touch canvasRef/ctxRef/sizeRef) are stripped
 * away: a 2D context, the current World snapshot, the viewport size, and
 * the sprite lookup. Nothing else.
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
 *     floored so gameplay objects stay clearly visible; the field is
 *     correspondingly cropped behind the spawn edge via
 *     runCameraOffsetX();
 *   - ultrawide: capped so the game never gets absurd.
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
 * Left edge of the visible camera window, in simulation x units.
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
 * Renders one frame of MPGR Run onto `ctx`.
 *
 * Signature mirrors exactly what the original inline `draw` useCallback
 * closed over once its own canvas/context/size guard clauses (which stay
 * in RunGame.tsx, since they touch canvasRef/ctxRef/sizeRef) are stripped
 * away: a 2D context, the current World snapshot, the viewport size, and
 * the sprite lookup. Nothing else.
 */
export function drawRunFrame(
  ctx: CanvasRenderingContext2D,
  world: World,
  viewportWidth: number,
  height: number,
  getSprite: (src: string) => CanvasImageSource | null
): void {
    const width = MPGR_RUN_SIMULATION_WIDTH;
    const p = world.player;
    const playerScreenX = width * PLAYER_X;

    // ONE uniform gameplay scale + camera window (see runViewScale).
    const u = runViewScale(viewportWidth);
    const camX = runCameraOffsetX(viewportWidth);
    const visible = viewportWidth / u; // sim units across the screen
    // Design-space height: the vertical unit space the simulation's
    // visual helpers (lane anchors, burst spawn y) are computed in.
    const designHeight = height / u;
    const laneY = (lane: number) => laneBaselineScreenY(designHeight, lane);

    // --- Backdrop (screen space) ---------------------------------------
    // Sky + parallax are drawn in raw screen pixels so the city artwork
    // can keep its natural 3:2 aspect (height-fit, tiled horizontally)
    // instead of being stretched to the canvas shape. traveledPx is
    // simulation px — multiply by u for the on-screen scroll speed, so
    // the backdrop keeps pace with the entities.
    ctx.save();
    if (world.screenShake > 0.5) {
      ctx.translate((Math.random() - 0.5) * world.screenShake, (Math.random() - 0.5) * world.screenShake);
    }
    ctx.clearRect(-40, -40, viewportWidth + 80, height + 80);
    const skyGradient = ctx.createLinearGradient(0, 0, 0, height);
    skyGradient.addColorStop(0, "#0A0B0D");
    skyGradient.addColorStop(0.55, "#0D1420");
    skyGradient.addColorStop(1, "#111826");
    ctx.fillStyle = skyGradient;
    ctx.fillRect(-40, -40, viewportWidth + 80, height + 80);

    // Real "City Run" artwork, three depth layers scrolling at different
    // rates tied to actual distance traveled (so it pauses correctly and
    // never drifts out of sync with the game clock).
    const cityBg = getSprite(CITY_ENVIRONMENT.background);
    const cityMid = getSprite(CITY_ENVIRONMENT.midground);
    const cityFg = getSprite(CITY_ENVIRONMENT.foreground);
    const cityReady = !!(cityBg && cityMid && cityFg);
    const drawParallaxLayer = (img: CanvasImageSource | null, speedFactor: number, alpha: number) => {
      if (!img) return;
      const layerW = height * RUN_CITY_ART_ASPECT;
      const offset = (world.traveledPx * speedFactor * u) % layerW;
      const copies = Math.ceil(viewportWidth / layerW) + 1;
      ctx.globalAlpha = alpha;
      for (let i = 0; i <= copies; i++) {
        ctx.drawImage(img, i * layerW - offset, 0, layerW, height);
      }
      ctx.globalAlpha = 1;
    };
    // All three layers or none — a late mid/fg arriving after bg would
    // otherwise jump the city from "half-loaded" to full mid-run.
    if (cityReady) {
      drawParallaxLayer(cityBg, 0.05, 0.9);
      drawParallaxLayer(cityMid, 0.15, 0.85);
      drawParallaxLayer(cityFg, 0.35, 0.8);
    }

    // Procedural skyline glow strips — fallback only until every city
    // layer is load+decode-ready as a set.
    if (!cityReady) {
      const gap = 140 * u;
      const scroll = ((world.elapsedMs / 40) * u) % gap;
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = "#3B82F6";
      for (let bx = -scroll - gap; bx < viewportWidth + gap; bx += gap) {
        ctx.fillRect(bx, height * 0.18, 44 * u, height * 0.32);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    // --- World (uniform sim/design space, camera-translated) -----------
    ctx.save();
    ctx.scale(u, u);
    ctx.translate(-camX, 0);
    if (world.screenShake > 0.5) {
      ctx.translate((Math.random() - 0.5) * world.screenShake, (Math.random() - 0.5) * world.screenShake);
    }

    // Three lane tracks.
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const y = laneY(lane);
      const isCurrent = lane === p.lane;
      ctx.strokeStyle = COLORS.laneLine;
      ctx.globalAlpha = isCurrent ? 0.55 : 0.18;
      ctx.lineWidth = isCurrent ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(camX, y);
      ctx.lineTo(camX + visible, y);
      ctx.stroke();
      if (isCurrent) {
        const glow = ctx.createLinearGradient(0, y - 10, 0, y + 4);
        glow.addColorStop(0, "rgba(59,130,246,0.16)");
        glow.addColorStop(1, "rgba(59,130,246,0)");
        ctx.fillStyle = glow;
        ctx.fillRect(camX, y - 10, visible, 14);
      }
    }
    ctx.globalAlpha = 1;

    // Checkpoint flash.
    if (world.elapsedMs < world.checkpointFlashUntilMs) {
      const elapsedSinceStart = 1400 - (world.checkpointFlashUntilMs - world.elapsedMs);
      const remaining = (world.checkpointFlashUntilMs - world.elapsedMs) / 1400;
      const flashAlpha = clamp(remaining, 0, 1);
      ctx.globalAlpha = flashAlpha * 0.5;
      ctx.fillStyle = "#FBBF24";
      ctx.fillRect(camX, 0, visible, designHeight);
      ctx.globalAlpha = 1;

      const checkpointImg = getSprite(CHECKPOINT_SPRITE);
      if (checkpointImg) {
        // Ease-out scale-in over the first 260ms, then hold, then fade with the flash alpha.
        const growT = clamp(elapsedSinceStart / 260, 0, 1);
        const easedGrow = 1 - Math.pow(1 - growT, 3);
        const baseSize = Math.min(visible, designHeight) * 0.28;
        const size = baseSize * (0.7 + easedGrow * 0.3);
        const cx = camX + visible / 2;
        const cy = designHeight * 0.22;

        // Radiating ring pulse behind the badge.
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

    // Power-up pickups.
    for (const pu of world.powerups) {
      if (pu.collected) continue;
      const y = laneY(pu.lane);
      const bob = Math.sin(world.elapsedMs / 260 + pu.id) * 5;
      const cfg = POWERUP_TYPES[pu.type];
      const puImg = getSprite(POWERUP_SPRITES[pu.type]);
      const puCy = y - 20 + bob;
      ctx.shadowColor = cfg.color;
      ctx.shadowBlur = 12;
      if (puImg) {
        const size = pu.radius * 2.6;
        ctx.drawImage(puImg, pu.x - size / 2, puCy - size / 2, size, size);
      } else {
        ctx.beginPath();
        ctx.arc(pu.x, puCy, pu.radius, 0, Math.PI * 2);
        ctx.fillStyle = cfg.color;
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
    }

    // Collectibles.
    for (const c of world.collectibles) {
      if (c.collected) continue;
      const y = laneY(c.lane);
      const bob = Math.sin(world.elapsedMs / 300 + c.id) * 6;
      const attracting = c.magnetizedAtMs !== undefined;
      const shrink = attracting ? clamp(1 - (world.elapsedMs - c.magnetizedAtMs!) / MAGNET_ATTRACT_MS, 0.25, 1) : 1;
      const color = COLLECTIBLE_TYPES[c.type].color;
      const cImg = getSprite(COLLECTIBLE_SPRITES[c.type]);
      const cCy = y - 14 + bob;
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
      if (cImg) {
        const size = c.radius * 2.4 * shrink;
        ctx.drawImage(cImg, c.x - size / 2, cCy - size / 2, size, size);
      } else {
        ctx.beginPath();
        ctx.arc(c.x, cCy, c.radius * shrink, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.6)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
      if (attracting) {
        ctx.strokeStyle = "rgba(34,211,238,0.5)";
        ctx.beginPath();
        ctx.moveTo(c.x, cCy);
        ctx.lineTo(playerScreenX + PLAYER_SIZE / 2, laneY(p.lane) - p.playerY - PLAYER_SIZE / 2);
        ctx.stroke();
      }
    }

    // Obstacles.
    for (const o of world.obstacles) {
      const y = laneY(o.lane);
      const top = y - o.groundHeight - o.height;
      const bottom = y - o.groundHeight;
      const palette = OBSTACLE_COLOR[o.type];
      const oImg = getSprite(OBSTACLE_SPRITES[o.type]);
      ctx.save();
      if (o.type === "saw") {
        const cx = o.x + o.width / 2;
        const cy = (top + bottom) / 2;
        ctx.translate(cx, cy);
        ctx.rotate(world.elapsedMs / 120);
        ctx.translate(-cx, -cy);
      }
      ctx.globalAlpha = o.hit ? 0.55 : 1;
      if (oImg) {
        const drawW = o.width * 1.5;
        const drawH = o.height + o.groundHeight + 8;
        ctx.shadowColor = palette.fill;
        ctx.shadowBlur = o.hit ? 0 : 6;
        if (o.type === "saw") {
          ctx.drawImage(oImg, -drawW / 2, -drawH / 2, drawW, drawH);
        } else {
          ctx.drawImage(oImg, o.x + o.width / 2 - drawW / 2, bottom - drawH, drawW, drawH);
        }
        ctx.shadowBlur = 0;
      } else {
        const gradient = ctx.createLinearGradient(o.x, top, o.x, bottom);
        gradient.addColorStop(0, palette.fill);
        gradient.addColorStop(1, palette.dark);
        ctx.fillStyle = gradient;
        ctx.shadowColor = palette.fill;
        ctx.shadowBlur = o.hit ? 0 : 6;
        const r = 4;
        ctx.beginPath();
        ctx.moveTo(o.x + r, top);
        ctx.lineTo(o.x + o.width - r, top);
        ctx.quadraticCurveTo(o.x + o.width, top, o.x + o.width, top + r);
        ctx.lineTo(o.x + o.width, bottom);
        ctx.lineTo(o.x, bottom);
        ctx.lineTo(o.x, top + r);
        ctx.quadraticCurveTo(o.x, top, o.x + r, top);
        ctx.closePath();
        ctx.fill();
        ctx.shadowBlur = 0;
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    // Particles (y in design units, spawned by the simulation).
    for (const part of world.particles) {
      const alpha = clamp(part.life / part.maxLife, 0, 1);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = part.color;
      ctx.beginPath();
      ctx.arc(part.x, part.y, part.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Sprite bursts — real explosion/coin/gem artwork, growing and fading out.
    for (const burst of world.spriteBursts) {
      const img = getSprite(burst.sprite);
      if (!img) continue;
      const t = clamp((world.elapsedMs - burst.startMs) / burst.durationMs, 0, 1);
      const size = burst.maxSize * (0.5 + t * 0.6);
      ctx.globalAlpha = 1 - t;
      ctx.drawImage(img, burst.x - size / 2, burst.y - size / 2, size, size);
    }
    ctx.globalAlpha = 1;

    // Player — drawn from the smoothed lane offset so switching lanes glides
    // instead of snapping (collision above always uses the logical p.lane).
    const baselineY = designHeight * LANE_CENTER_Y + p.laneOffset;
    const playerHeight = p.sliding ? PLAYER_SIZE * SLIDE_HITBOX_SCALE : PLAYER_SIZE;
    const playerBottom = baselineY - p.playerY;
    const playerTop = playerBottom - playerHeight;
    const invulnerable = world.elapsedMs < p.invulnerableUntilMs;
    const shielded = !!world.activePowerups.shield || !!world.activePowerups.invincibility;

    if (shielded) {
      ctx.beginPath();
      ctx.arc(playerScreenX + PLAYER_SIZE / 2, (playerTop + playerBottom) / 2, PLAYER_SIZE * 0.9, 0, Math.PI * 2);
      ctx.strokeStyle = world.activePowerups.invincibility ? "#F472B6" : "#34D399";
      ctx.globalAlpha = 0.6 + Math.sin(world.elapsedMs / 90) * 0.2;
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (world.activePowerups.jetpack) {
      // Layered flicker flame — richer than a single triangle, still pure procedural VFX.
      for (let layer = 0; layer < 2; layer++) {
        const flicker = Math.random() * 8;
        const len = 14 + layer * 8 + flicker;
        ctx.beginPath();
        ctx.moveTo(playerScreenX + 2, playerBottom - 2 - layer * 3);
        ctx.lineTo(playerScreenX - len, playerBottom + 4 + layer * 2);
        ctx.lineTo(playerScreenX + 2, playerBottom + 8 + layer * 3);
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
    if (world.activePowerups.speed) {
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = COLORS.player;
      for (let i = 1; i <= 3; i++) {
        ctx.fillRect(playerScreenX - i * 10, playerTop + 4, 6, playerHeight - 8);
      }
      ctx.globalAlpha = 1;
    }

    ctx.globalAlpha = invulnerable && !shielded ? 0.4 + Math.sin(world.elapsedMs / 60) * 0.3 : 1;

    const jetpackActiveNow = !!world.activePowerups.jetpack;
    // A gentle vertical bob while grounded and running — cosmetic only, applied
    // solely to where the sprite is drawn, never to playerTop/playerBottom (which
    // stay authoritative for collision, the shield ring, and every other effect).
    const grounded = p.playerY <= 0 && !p.sliding && !jetpackActiveNow;
    const runBob = grounded ? Math.abs(Math.sin(world.elapsedMs / 120)) * 2.5 : 0;

    let spriteSrc: string = CHARACTER_SPRITES.run;
    // NOTE: mpgr-runner-fly.webp is intentionally excluded from run-assets.ts
    // (baked non-uniform sky background, unsafe to auto-cutout — see the
    // audit note there), so jetpack reuses the properly transparent `jump`
    // pose plus the flame VFX above and a forward flight tilt below.
    if (jetpackActiveNow) spriteSrc = CHARACTER_SPRITES.jump;
    else if (p.sliding) spriteSrc = CHARACTER_SPRITES.slide;
    else if (p.playerY > 0) spriteSrc = p.velocityY > 0 ? CHARACTER_SPRITES.jump : CHARACTER_SPRITES.fall;
    else spriteSrc = Math.floor(world.elapsedMs / 120) % 2 === 0 ? CHARACTER_SPRITES.run : CHARACTER_SPRITES.run2;
    let playerImg = getSprite(spriteSrc);
    // If the pose for this frame isn't decode-ready yet, hold a current-version
    // stand-in (run / jump / idle) rather than flickering to the procedural
    // capsule every other run-cycle frame. Procedural is the last resort.
    if (!playerImg) {
      playerImg =
        getSprite(CHARACTER_SPRITES.run) ??
        getSprite(CHARACTER_SPRITES.jump) ??
        getSprite(CHARACTER_SPRITES.idle);
    }

    if (playerImg) {
      const drawW = PLAYER_SIZE * 1.9;
      const drawH = playerHeight * 1.9;
      const cx = playerScreenX + PLAYER_SIZE / 2;
      const cy = playerBottom - drawH / 2 - runBob;
      ctx.save();
      ctx.translate(cx, cy);
      if (jetpackActiveNow) ctx.rotate(-0.12);
      ctx.shadowColor = "rgba(59,130,246,0.55)";
      ctx.shadowBlur = 14;
      ctx.drawImage(playerImg, -drawW / 2, -drawH / 2, drawW, drawH);
      ctx.shadowBlur = 0;
      ctx.restore();
    } else {
      const grad = ctx.createLinearGradient(0, playerTop, 0, playerBottom);
      grad.addColorStop(0, COLORS.player);
      grad.addColorStop(1, COLORS.playerCore);
      ctx.fillStyle = grad;
      ctx.shadowColor = "rgba(59,130,246,0.55)";
      ctx.shadowBlur = 14;
      const pr = 7;
      ctx.beginPath();
      ctx.moveTo(playerScreenX + pr, playerTop);
      ctx.lineTo(playerScreenX + PLAYER_SIZE - pr, playerTop);
      ctx.quadraticCurveTo(playerScreenX + PLAYER_SIZE, playerTop, playerScreenX + PLAYER_SIZE, playerTop + pr);
      ctx.lineTo(playerScreenX + PLAYER_SIZE, playerBottom - pr);
      ctx.quadraticCurveTo(playerScreenX + PLAYER_SIZE, playerBottom, playerScreenX + PLAYER_SIZE - pr, playerBottom);
      ctx.lineTo(playerScreenX + pr, playerBottom);
      ctx.quadraticCurveTo(playerScreenX, playerBottom, playerScreenX, playerBottom - pr);
      ctx.lineTo(playerScreenX, playerTop + pr);
      ctx.quadraticCurveTo(playerScreenX, playerTop, playerScreenX + pr, playerTop);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#0A0B0D";
      ctx.fillRect(playerScreenX + PLAYER_SIZE * 0.45, playerTop + playerHeight * 0.28, PLAYER_SIZE * 0.4, playerHeight * 0.22);
    }
    ctx.globalAlpha = 1;

    // Cinematic vignette — a constant, subtle cyberpunk framing so the
    // premium mood holds even where no sprite/particle is on screen.
    // Drawn over the whole camera window (not just the 960-unit field)
    // so ultrawide zoomed views are covered edge to edge.
    const vignette = ctx.createRadialGradient(
      camX + visible / 2,
      designHeight / 2,
      Math.min(visible, designHeight) * 0.35,
      camX + visible / 2,
      designHeight / 2,
      Math.max(visible, designHeight) * 0.7
    );
    vignette.addColorStop(0, "rgba(0,0,0,0)");
    vignette.addColorStop(1, "rgba(0,0,0,0.38)");
    ctx.fillStyle = vignette;
    ctx.fillRect(camX, 0, visible, designHeight);

    // Hit-damage flash — a brief red pulse over the whole frame, on top of
    // everything else, so a hit always reads clearly even mid-chaos.
    if (world.elapsedMs < world.hitFlashUntilMs) {
      const hitT = clamp((world.hitFlashUntilMs - world.elapsedMs) / 220, 0, 1);
      ctx.globalAlpha = hitT * 0.35;
      ctx.fillStyle = "#DC2626";
      ctx.fillRect(camX, 0, visible, designHeight);
      ctx.globalAlpha = 1;
    }

    ctx.restore();
}
