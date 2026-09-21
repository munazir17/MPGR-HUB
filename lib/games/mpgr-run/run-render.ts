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
 */
/** Natural aspect of the city parallax artwork (1536x1024 source files). */
const RUN_CITY_ART_ASPECT = 1536 / 1024;

/**
 * Vertical gameplay scale for the responsive renderer.
 *
 * The simulation is untouched: the world is 960 units wide, entities
 * spawn at x=960, and the authoritative replay verifies every collision
 * in those fixed units. Rendering, however, must scale with the real
 * viewport so a desktop canvas gets a genuinely LARGER game instead of
 * the same tiny phone sprites swimming in extra space:
 *
 *   - horizontal: sx = viewportWidth / 960 always shows the FULL
 *     simulation width (cropping the field would cut reaction time —
 *     a gameplay change, not a layout one);
 *   - vertical: sy scales the fixed-pixel gameplay units (player size,
 *     lane gap, obstacle heights, jump arcs…) up with the canvas width,
 *     floored at 1 so phones keep their current readable sizes and
 *     capped so ultrawide monitors don't get absurd.
 *
 * On desktop/tablet widths sx ≈ sy, so characters, obstacles and hitboxes
 * stay proportional. Lanes remain anchored at LANE_CENTER_Y of the
 * canvas, so tall screens show more sky/street rather than a squashed
 * band.
 */
export function runVerticalScale(viewportWidth: number): number {
  return clamp(viewportWidth / MPGR_RUN_SIMULATION_WIDTH, 1, 2.25);
}

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

    const sx = viewportWidth / width;
    const sy = runVerticalScale(viewportWidth);
    // Design-space height: the height the simulation's visual spawn
    // helpers should see so their y coordinates match this render.
    // laneY(lane) below is exactly laneBaselineScreenY(designHeight) * sy.
    const designHeight = height / sy;
    const laneY = (lane: number) => laneBaselineScreenY(designHeight, lane) * sy;

    // --- Backdrop (screen space) ---------------------------------------
    // Sky + parallax are drawn in raw screen pixels so the city artwork
    // can keep its natural 3:2 aspect (height-fit, tiled horizontally)
    // instead of being stretched to the canvas shape — that stretch was
    // what made buildings look compressed on phones and bloated on
    // wide desktops.
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
    // never drifts out of sync with the game clock). traveledPx is
    // simulation px — multiply by sx for the on-screen scroll speed, so
    // the backdrop keeps pace with the entities.
    const cityBg = getSprite(CITY_ENVIRONMENT.background);
    const cityMid = getSprite(CITY_ENVIRONMENT.midground);
    const cityFg = getSprite(CITY_ENVIRONMENT.foreground);
    const cityReady = !!(cityBg && cityMid && cityFg);
    const drawParallaxLayer = (img: CanvasImageSource | null, speedFactor: number, alpha: number) => {
      if (!img) return;
      const layerW = height * RUN_CITY_ART_ASPECT;
      const offset = (world.traveledPx * speedFactor * sx) % layerW;
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
      const gap = 140 * sx;
      const scroll = ((world.elapsedMs / 40) * sx) % gap;
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = "#3B82F6";
      for (let bx = -scroll - gap; bx < viewportWidth + gap; bx += gap) {
        ctx.fillRect(bx, height * 0.18, 44 * sx, height * 0.32);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    // --- World (simulation x-space, vertical gameplay units × sy) -----
    ctx.save();
    ctx.scale(sx, 1);
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
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
      if (isCurrent) {
        const glow = ctx.createLinearGradient(0, y - 10 * sy, 0, y + 4 * sy);
        glow.addColorStop(0, "rgba(59,130,246,0.16)");
        glow.addColorStop(1, "rgba(59,130,246,0)");
        ctx.fillStyle = glow;
        ctx.fillRect(0, y - 10 * sy, width, 14 * sy);
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
      ctx.fillRect(0, 0, width, height);
      ctx.globalAlpha = 1;

      const checkpointImg = getSprite(CHECKPOINT_SPRITE);
      if (checkpointImg) {
        // Ease-out scale-in over the first 260ms, then hold, then fade with the flash alpha.
        const growT = clamp(elapsedSinceStart / 260, 0, 1);
        const easedGrow = 1 - Math.pow(1 - growT, 3);
        const baseSize = Math.min(width, height) * 0.28;
        const size = baseSize * (0.7 + easedGrow * 0.3);
        const cx = width / 2;
        const cy = height * 0.22;

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
      const bob = Math.sin(world.elapsedMs / 260 + pu.id) * 5 * sy;
      const cfg = POWERUP_TYPES[pu.type];
      const puImg = getSprite(POWERUP_SPRITES[pu.type]);
      const puCy = y - 20 * sy + bob;
      ctx.shadowColor = cfg.color;
      ctx.shadowBlur = 12;
      if (puImg) {
        const size = pu.radius * 2.6 * sy;
        ctx.drawImage(puImg, pu.x - size / 2, puCy - size / 2, size, size);
      } else {
        ctx.beginPath();
        ctx.arc(pu.x, puCy, pu.radius * sy, 0, Math.PI * 2);
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
      const bob = Math.sin(world.elapsedMs / 300 + c.id) * 6 * sy;
      const attracting = c.magnetizedAtMs !== undefined;
      const shrink = attracting ? clamp(1 - (world.elapsedMs - c.magnetizedAtMs!) / MAGNET_ATTRACT_MS, 0.25, 1) : 1;
      const color = COLLECTIBLE_TYPES[c.type].color;
      const cImg = getSprite(COLLECTIBLE_SPRITES[c.type]);
      const cCy = y - 14 * sy + bob;
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
      if (cImg) {
        const size = c.radius * 2.4 * shrink * sy;
        ctx.drawImage(cImg, c.x - size / 2, cCy - size / 2, size, size);
      } else {
        ctx.beginPath();
        ctx.arc(c.x, cCy, c.radius * shrink * sy, 0, Math.PI * 2);
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
        ctx.lineTo(playerScreenX + PLAYER_SIZE / 2, laneY(p.lane) - (p.playerY + PLAYER_SIZE / 2) * sy);
        ctx.stroke();
      }
    }

    // Obstacles.
    for (const o of world.obstacles) {
      const y = laneY(o.lane);
      const top = y - (o.groundHeight + o.height) * sy;
      const bottom = y - o.groundHeight * sy;
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
        const drawH = (o.height + o.groundHeight + 8) * sy;
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
        const r = 4 * sy;
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

    // Particles (y stored in design space by the simulation).
    for (const part of world.particles) {
      const alpha = clamp(part.life / part.maxLife, 0, 1);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = part.color;
      ctx.beginPath();
      ctx.arc(part.x, part.y * sy, part.size * sy, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Sprite bursts — real explosion/coin/gem artwork, growing and fading out.
    for (const burst of world.spriteBursts) {
      const img = getSprite(burst.sprite);
      if (!img) continue;
      const t = clamp((world.elapsedMs - burst.startMs) / burst.durationMs, 0, 1);
      const size = burst.maxSize * (0.5 + t * 0.6) * sy;
      ctx.globalAlpha = 1 - t;
      ctx.drawImage(img, burst.x - size / 2, burst.y * sy - size / 2, size, size);
    }
    ctx.globalAlpha = 1;

    // Player — drawn from the smoothed lane offset so switching lanes glides
    // instead of snapping (collision above always uses the logical p.lane).
    const baselineY = height * LANE_CENTER_Y + p.laneOffset * sy;
    const playerHeight = (p.sliding ? PLAYER_SIZE * SLIDE_HITBOX_SCALE : PLAYER_SIZE) * sy;
    const playerBottom = baselineY - p.playerY;
    const playerTop = playerBottom - playerHeight;
    const invulnerable = world.elapsedMs < p.invulnerableUntilMs;
    const shielded = !!world.activePowerups.shield || !!world.activePowerups.invincibility;

    if (shielded) {
      ctx.beginPath();
      ctx.arc(playerScreenX + PLAYER_SIZE / 2, (playerTop + playerBottom) / 2, PLAYER_SIZE * 0.9 * sy, 0, Math.PI * 2);
      ctx.strokeStyle = world.activePowerups.invincibility ? "#F472B6" : "#34D399";
      ctx.globalAlpha = 0.6 + Math.sin(world.elapsedMs / 90) * 0.2;
      ctx.lineWidth = 2.5 * sy;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (world.activePowerups.jetpack) {
      // Layered flicker flame — richer than a single triangle, still pure procedural VFX.
      for (let layer = 0; layer < 2; layer++) {
        const flicker = Math.random() * 8;
        const len = (14 + layer * 8 + flicker) * sy;
        ctx.beginPath();
        ctx.moveTo(playerScreenX + 2, playerBottom - (2 + layer * 3) * sy);
        ctx.lineTo(playerScreenX - len, playerBottom + (4 + layer * 2) * sy);
        ctx.lineTo(playerScreenX + 2, playerBottom + (8 + layer * 3) * sy);
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
        ctx.fillRect(playerScreenX - i * 10, playerTop + 4 * sy, 6, playerHeight - 8 * sy);
      }
      ctx.globalAlpha = 1;
    }

    ctx.globalAlpha = invulnerable && !shielded ? 0.4 + Math.sin(world.elapsedMs / 60) * 0.3 : 1;

    const jetpackActiveNow = !!world.activePowerups.jetpack;
    // A gentle vertical bob while grounded and running — cosmetic only, applied
    // solely to where the sprite is drawn, never to playerTop/playerBottom (which
    // stay authoritative for collision, the shield ring, and every other effect).
    const grounded = p.playerY <= 0 && !p.sliding && !jetpackActiveNow;
    const runBob = grounded ? Math.abs(Math.sin(world.elapsedMs / 120)) * 2.5 * sy : 0;

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
      const pr = 7 * sy;
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
    const vignette = ctx.createRadialGradient(
      width / 2,
      height / 2,
      Math.min(width, height) * 0.35,
      width / 2,
      height / 2,
      Math.max(width, height) * 0.7
    );
    vignette.addColorStop(0, "rgba(0,0,0,0)");
    vignette.addColorStop(1, "rgba(0,0,0,0.38)");
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, width, height);

    // Hit-damage flash — a brief red pulse over the whole frame, on top of
    // everything else, so a hit always reads clearly even mid-chaos.
    if (world.elapsedMs < world.hitFlashUntilMs) {
      const hitT = clamp((world.hitFlashUntilMs - world.elapsedMs) / 220, 0, 1);
      ctx.globalAlpha = hitT * 0.35;
      ctx.fillStyle = "#DC2626";
      ctx.fillRect(0, 0, width, height);
      ctx.globalAlpha = 1;
    }

    ctx.restore();
}
