import type { RunWorldTheme } from "./run-environments";

/** Presentation-only street geometry. No random source, clock or simulation writes. */
export const STREET_FOCAL = 300;
export const STREET_HORIZON = 0.54;
export const STREET_GROUND = 0.84;
export const RUNNER_HEIGHT_FRACTION = 0.165;
export const STREET_SPACING = 230;
export const STREET_BLOCKS = 23;

export function streetHash(index: number, salt: number): number {
  let n = Math.imul(index ^ salt, 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

export function streetLaneGap(width: number, height: number): number {
  return Math.min(width * 0.24, height * 0.21);
}

/** Shared ground and vertical projection: buildings cannot lean or float. */
export function streetScale(z: number): number {
  return STREET_FOCAL / (STREET_FOCAL + z);
}

export function streetGround(height: number, z: number): number {
  return height * (STREET_HORIZON + (STREET_GROUND - STREET_HORIZON) * streetScale(z));
}

const MATERIALS = {
  city: { front: "#111d38", side: "#0a1329", roof: "#293356", window: "#55b7d9", recess: "#080f21", trim: "#585383" },
  ice: { front: "#b4d8e9", side: "#578ba9", roof: "#e8f5fa", window: "#d9f7ff", recess: "#366781", trim: "#d5edf5" },
  desert: { front: "#d6a36e", side: "#926445", roof: "#f2ca91", window: "#ffd795", recess: "#614432", trim: "#e4ba85" },
} as const;

// Mip levels are built once per decoded atlas, not once per building/frame.
// They avoid repeatedly minifying a 512x768 texture into subpixel far walls.
const mipmaps = new WeakMap<object, CanvasImageSource[]>();
function facadeMip(source: CanvasImageSource, height: number): CanvasImageSource {
  if (typeof document === "undefined") return source;
  let levels = mipmaps.get(source);
  if (!levels) {
    levels = [source];
    const image = source as HTMLImageElement;
    let w = image.naturalWidth || image.width, h = image.naturalHeight || image.height;
    for (let i = 0; i < 4; i++) {
      w = Math.max(1, Math.round(w / 2)); h = Math.max(1, Math.round(h / 2));
      const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
      const context = canvas.getContext("2d");
      if (!context) break;
      context.drawImage(levels[levels.length - 1], 0, 0, w, h);
      levels.push(canvas);
    }
    mipmaps.set(source, levels);
  }
  const level = height < 48 ? 4 : height < 96 ? 3 : height < 192 ? 2 : height < 384 ? 1 : 0;
  return levels[Math.min(level, levels.length - 1)];
}

/**
 * A bounded street of solid prisms, not billboard sprites. Each wall uses
 * its own near/far depth, and each window is projected onto that wall.
 * Far buildings get fewer floors/windows. The loop is fixed at 46 blocks;
 * invisible walls are culled before detail work. No per-building objects,
 * closures, particle arrays or gameplay RNG calls are created.
 */
export function drawStreetArchitecture(
  ctx: CanvasRenderingContext2D,
  width: number, height: number, trackHalf: number, cameraLateral: number,
  traveled: number, elapsed: number, theme: RunWorldTheme,
  texture: CanvasImageSource | null = null,
): void {
  const material = MATERIALS[theme.id];
  const center = width / 2 - cameraLateral;
  const residue = ((-traveled % STREET_SPACING) + STREET_SPACING) % STREET_SPACING;
  for (let i = STREET_BLOCKS - 1; i >= 0; i--) {
    const z = residue + i * STREET_SPACING - 160;
    const index = Math.round((z + traveled + 160) / STREET_SPACING);
    const farZ = z + STREET_SPACING * (0.72 + streetHash(index, 119) * 0.19);
    const nearS = streetScale(z), farS = streetScale(farZ);
    const groundNear = streetGround(height, z), groundFar = streetGround(height, farZ);
    for (let side = -1; side <= 1; side += 2) {
      const r = streetHash(index, side + 83);
      // Independently salted profiles: rare landmarks reuse a street slot,
      // never add objects or consume the authoritative random stream.
      const profile = streetHash(index, side < 0 ? 401 : 719);
      const landmark = profile > 0.955;
      const totalHeight = height * (0.25 + r * r * 0.78) * (landmark ? 1.12 : 1);
      const stepped = r > 0.68; // keep the existing number of upper volumes
      const buildingHeight = totalHeight * (stepped ? 0.64 + profile * 0.13 : 1);
      const inner = side * (trackHalf + height * (0.045 + streetHash(index, side + 12) * 0.018));
      const outer = inner + side * height * (0.12 + streetHash(index, side + 17) * 0.22) * (landmark ? 1.08 : 1);
      const xn = center + inner * nearS, xf = center + inner * farS;
      const xo = center + outer * nearS, xof = center + outer * farS;
      if (Math.min(xn, xf, xo, xof) > width + 4 || Math.max(xn, xf, xo, xof) < -4) continue;
      const yn = groundNear - buildingHeight * nearS, yf = groundFar - buildingHeight * farS;
      const fog = Math.min(0.86, Math.max(0, z) / 6000);
      // AO contact footprint stays on the same ground plane as the wall.
      ctx.fillStyle = theme.id === "ice" ? "rgba(25,60,80,0.14)" : theme.id === "desert" ? "rgba(65,40,20,0.18)" : "rgba(5,12,20,0.22)";
      quad(ctx, xn - side * 9 * nearS, groundNear, xo, groundNear, xof, groundFar, xf - side * 9 * farS, groundFar);
      // A second, inset solid volume on selected roofs. Its base is exactly
      // the main roof plane; verticals share x at top/bottom, never lean.
      // Two faces, cached atlas detail and fog; no filters/scene objects.
      if (stepped) {
        const upperInner = inner + (outer - inner) * (0.18 + profile * 0.16);
        const upperOuter = outer - (outer - inner) * (0.09 + streetHash(index, side + 331) * 0.13);
        const un = center + upperInner * nearS, uf = center + upperInner * farS;
        const uo = center + upperOuter * nearS;
        const tn = groundNear - totalHeight * nearS, tf = groundFar - totalHeight * farS;
        ctx.fillStyle = material.front;
        quad(ctx, un, tn, uf, tf, uf, yf, un, yn);
        ctx.fillStyle = material.side;
        quad(ctx, un, tn, uo, tn, uo, yn, un, yn);
        if (texture && z < 2300) {
          const mapped = facadeMip(texture, (totalHeight - buildingHeight) * nearS);
          const image = mapped as HTMLImageElement;
          const iw = image.naturalWidth || image.width, ih = image.naturalHeight || image.height;
          // At most six strips on the inset volume, reusing the decoded mip
          // atlas. No blank giant rooftop boxes or new texture allocations.
          const slices = Math.max(2, Math.min(6, Math.ceil(Math.abs(un - uf) / 8)));
          ctx.save();
          ctx.beginPath(); ctx.moveTo(un, tn); ctx.lineTo(uf, tf); ctx.lineTo(uf, yf); ctx.lineTo(un, yn); ctx.closePath(); ctx.clip();
          for (let slice = 0; slice < slices; slice++) {
            const a = slice / slices, b = (slice + 1) / slices;
            const sa = streetScale(z + (farZ - z) * a), sb = streetScale(z + (farZ - z) * b);
            const xa = center + upperInner * sa, xb = center + upperInner * sb, sm = (sa + sb) / 2;
            const top = height * (STREET_HORIZON + (STREET_GROUND - STREET_HORIZON) * sm) - totalHeight * sm;
            ctx.drawImage(mapped, iw * a, 0, iw / slices, ih * 0.4, Math.min(xa, xb), top, Math.abs(xa - xb) + 0.5, (totalHeight - buildingHeight) * sm);
          }
          ctx.restore();
          ctx.drawImage(mapped, 0, 0, iw, ih * 0.4, Math.min(un, uo), tn, Math.abs(uo - un), yn - tn);
          ctx.globalAlpha = 0.23 + profile * 0.18;
          ctx.fillStyle = material.side;
          quad(ctx, un, tn, uo, tn, uo, yn, un, yn);
          ctx.globalAlpha = 1;
        }
        ctx.fillStyle = theme.fog;
        ctx.globalAlpha = fog;
        quad(ctx, un, tn, uf, tf, uf, yf, un, yn);
        quad(ctx, un, tn, uo, tn, uo, yn, un, yn);
        ctx.globalAlpha = 1;
      }
      const facade = ctx.createLinearGradient(xn, yn, xf, groundFar);
      facade.addColorStop(0, material.front);
      facade.addColorStop(1, material.side);
      ctx.fillStyle = facade;
      quad(ctx, xn, yn, xf, yf, xf, groundFar, xn, groundNear);
      ctx.fillStyle = material.side;
      quad(ctx, xn, yn, xo, yn, xo, groundNear, xn, groundNear);
      ctx.fillStyle = material.roof;
      if (buildingHeight < height * (STREET_GROUND - STREET_HORIZON)) {
        quad(ctx, xn, yn, xo, yn, xof, yf, xf, yf);
      }

      if (texture && z < 2300) {
        // Strip projection follows the wall's own near/far scale; unlike a
        // sprite card its top, base and texture converge toward the horizon.
        // <= 12 strips per visible wall, cached mip atlas, bounded projection strips.
        const mappedTexture = facadeMip(texture, buildingHeight * nearS);
        const image = mappedTexture as HTMLImageElement;
        const iw = image.naturalWidth || image.width, ih = image.naturalHeight || image.height;
        const slices = Math.max(2, Math.min(12, Math.ceil(Math.abs(xn - xf) / 5)));
        const crop = 0.58 + streetHash(index, side + 76) * 0.42;
        // Stable facade modules, rather than stretching the identical full
        // atlas across every block. Same number of texture draws as before.
        const moduleWidth = landmark ? 0.34 : 0.45 + Math.floor(streetHash(index, side + 91) * 3) * 0.25;
        const moduleStart = (1 - moduleWidth) * streetHash(index, side + 92);
        ctx.save();
        ctx.beginPath(); ctx.moveTo(xn, yn); ctx.lineTo(xf, yf); ctx.lineTo(xf, groundFar); ctx.lineTo(xn, groundNear); ctx.closePath(); ctx.clip();
        for (let slice = 0; slice < slices; slice++) {
          const a = slice / slices, b = (slice + 1) / slices;
          const sa = streetScale(z + (farZ - z) * a), sb = streetScale(z + (farZ - z) * b);
          const xa = center + inner * sa, xb = center + inner * sb;
          const sm = (sa + sb) / 2;
          const top = height * (STREET_HORIZON + (STREET_GROUND - STREET_HORIZON) * sm) - buildingHeight * sm;
          ctx.drawImage(mappedTexture, iw * (moduleStart + moduleWidth * a), ih * (1 - crop), iw * moduleWidth / slices, ih * crop, Math.min(xa, xb), top, Math.abs(xa - xb) + 0.5, buildingHeight * sm);
        }
        ctx.restore();
        ctx.drawImage(mappedTexture, iw * moduleStart, ih * (1 - crop), iw * moduleWidth, ih * crop, Math.min(xn, xo), yn, Math.abs(xo - xn), groundNear - yn);
        ctx.globalAlpha = 0.23 + profile * 0.18;
        ctx.fillStyle = material.side;
        quad(ctx, xn, yn, xo, yn, xo, groundNear, xn, groundNear);
        ctx.globalAlpha = 1;
      }

      // Floor courses and inset windows are attached to the projected wall,
      // never free-floating points in the sky. LOD bounds the mobile cost.
      const rows = z < 900 ? 12 : z < 2000 ? 6 : 3;
      const cols = z < 900 ? 5 : 2;
      for (let row = 1; row < rows && !texture; row++) {
        const h = buildingHeight * row / rows;
        ctx.strokeStyle = material.trim;
        ctx.globalAlpha = 0.25;
        ctx.lineWidth = Math.max(0.35, nearS * 0.7);
        ctx.beginPath();
        ctx.moveTo(xo, groundNear - h * nearS);
        ctx.lineTo(xn, groundNear - h * nearS);
        ctx.lineTo(xf, groundFar - h * farS);
        ctx.stroke();
        ctx.globalAlpha = 1;
        for (let col = 0; col < cols; col++) {
          const a = (col + 0.2) / cols, b = (col + 0.7) / cols;
          const sa = streetScale(z + (farZ - z) * a), sb = streetScale(z + (farZ - z) * b);
          const xa = center + inner * sa, xb = center + inner * sb;
          const ga = height * (STREET_HORIZON + (STREET_GROUND - STREET_HORIZON) * sa);
          const gb = height * (STREET_HORIZON + (STREET_GROUND - STREET_HORIZON) * sb);
          const wh = buildingHeight / rows * (theme.id === "desert" ? 0.45 : 0.6);
          const lit = streetHash(index * 103 + row * 7 + col, side + 50);
          const pulse = 0.85 + 0.15 * Math.sin(elapsed / 1600 + index + row);
          ctx.fillStyle = lit > 0.36 ? material.window : material.recess;
          ctx.globalAlpha = lit > 0.36 ? (0.3 + lit * 0.48) * pulse : 0.8;
          quad(ctx, xa, ga - (h + wh) * sa, xb, gb - (h + wh) * sb, xb, gb - h * sb, xa, ga - h * sa);
          // Front face apertures (different key/fill response from side wall).
          const fa = xn + (xo - xn) * a, fb = xn + (xo - xn) * b;
          ctx.globalAlpha *= 0.65;
          ctx.fillRect(Math.min(fa, fb), groundNear - (h + wh) * nearS, Math.abs(fb - fa), wh * nearS);
          ctx.globalAlpha = 1;
        }
      }
      // Pale roof accumulation / sandstone cornice; restrained cyan city trim.
      ctx.strokeStyle = theme.id === "city" && r > 0.78 ? theme.rail : material.roof;
      ctx.lineWidth = (theme.id === "ice" ? 5 : 2) * nearS;
      ctx.beginPath(); ctx.moveTo(xo, yn); ctx.lineTo(xn, yn); ctx.lineTo(xf, yf); ctx.stroke();
      if (theme.id !== "desert" && r > 0.55 && !stepped && !landmark) {
        ctx.fillStyle = material.trim;
        ctx.fillRect((xn + xo) / 2, yn - 28 * nearS, 1.4 * nearS, 28 * nearS);
      }
      // Occasional service crown/beacon, attached to the true upper roof.
      // Two small rects replace the generic silhouette, no blur or new mesh.
      if (landmark && z < 1800) {
        const roof = groundNear - totalHeight * nearS;
        const mid = (xn + xo) / 2;
        ctx.fillStyle = material.trim;
        ctx.fillRect(mid - 5 * nearS, roof - 19 * nearS, 10 * nearS, 19 * nearS);
        ctx.fillStyle = material.window;
        ctx.fillRect(mid - 3 * nearS, roof - 17 * nearS, 6 * nearS, 3 * nearS);
      }
      // Ground-floor shop glow plus its short wet-ground reflection.
      if (z < 1300) {
        // Recessed plinth ties both wall faces to their contact footprint.
        // Ground coordinates are identical to the wall, not a screen band.
        const plinth = height * (0.016 + streetHash(index, side + 97) * 0.012);
        ctx.fillStyle = theme.id === "ice" ? material.side : material.recess;
        quad(ctx, xn, groundNear - plinth * nearS, xf, groundFar - plinth * farS, xf, groundFar, xn, groundNear);
        quad(ctx, xn, groundNear - plinth * nearS, xo, groundNear - plinth * nearS, xo, groundNear, xn, groundNear);
        ctx.fillStyle = theme.twinkle[index % 2 === 0 ? 0 : 1];
        ctx.globalAlpha = theme.id === "desert" ? 0.2 : 0.55;
        quad(ctx, xn, groundNear - 10 * nearS, xf, groundFar - 10 * farS, xf, groundFar - 5 * farS, xn, groundNear - 5 * nearS);
        ctx.globalAlpha = theme.id === "desert" ? 0.035 : 0.1;
        quad(ctx, xn, groundNear, xf, groundFar, xf - side * 16 * farS, groundFar + 13 * farS, xn - side * 16 * nearS, groundNear + 13 * nearS);
        ctx.globalAlpha = 1;
      }
      // Tint solid geometry toward the atmospheric fill instead of fading
      // to transparency (which made the old PNG stacks look like ghosts).
      ctx.fillStyle = theme.fog;
      ctx.globalAlpha = fog;
      if (buildingHeight < height * (STREET_GROUND - STREET_HORIZON)) {
        quad(ctx, xo, yn, xn, yn, xf, yf, xof, yf);
      }
      quad(ctx, xn, yn, xf, yf, xf, groundFar, xn, groundNear);
      quad(ctx, xn, yn, xo, yn, xo, groundNear, xn, groundNear);
      ctx.globalAlpha = 1;
    }
  }
}

function quad(ctx: CanvasRenderingContext2D, ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): void {
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(cx, cy); ctx.lineTo(dx, dy); ctx.closePath(); ctx.fill();
}

/** Road material in world-locked depth cells. At most 90 narrow streaks. */
export function drawStreetSurface(ctx: CanvasRenderingContext2D, width: number, height: number, trackHalf: number, cam: number, traveled: number, theme: RunWorldTheme): void {
  const center = width / 2 - cam;
  const spacing = 37;
  const residue = ((-traveled % spacing) + spacing) % spacing;
  for (let i = 0; i < 90; i++) {
    const z = residue + Math.floor(i / 3) * spacing - 160;
    const k = Math.round((z + traveled + 160) / spacing) * 3 + i % 3;
    const lat = (streetHash(k, 301) * 2 - 1) * trackHalf * 0.95;
    const s = streetScale(z), sf = streetScale(z + 20 + streetHash(k, 43) * 60);
    const span = (0.3 + streetHash(k, 13) * 2.5);
    ctx.fillStyle = i % 3 === 0 ? theme.twinkle[0] : theme.twinkle[1];
    ctx.globalAlpha = (theme.id === "desert" ? 0.035 : 0.08) * Math.min(1, s);
    quad(ctx, center + (lat - span) * s, streetGround(height, z), center + (lat + span) * s, streetGround(height, z), center + (lat + span) * sf, streetGround(height, z + 20 + streetHash(k, 43) * 60), center + (lat - span) * sf, streetGround(height, z + 20 + streetHash(k, 43) * 60));
  }
  // Reflected street lights extend vertically DOWN from the actual curb
  // light positions into the widening foreground road; no floating bloom.
  if (theme.id !== "desert") {
    const lightResidue = ((-traveled % 260) + 260) % 260;
    for (let i = 0; i < 9; i++) {
      const z = lightResidue + i * 260;
      const s = streetScale(z), y = streetGround(height, z);
      const length = height * (theme.id === "ice" ? 0.22 : 0.28) * s;
      for (let side = -1; side <= 1; side += 2) {
        const x = center + side * (trackHalf + height * 0.025) * s;
        const glow = ctx.createLinearGradient(0, y, 0, y + length);
        const color = theme.twinkle[i % 2];
        glow.addColorStop(0, color); glow.addColorStop(1, color + "00");
        ctx.fillStyle = glow;
        ctx.globalAlpha = theme.id === "ice" ? 0.11 : 0.15;
        quad(ctx, x - 4 * s, y, x + 4 * s, y, x + 14 * s, y + length, x - 14 * s, y + length);
      }
    }
  }
  ctx.globalAlpha = 1;
}
