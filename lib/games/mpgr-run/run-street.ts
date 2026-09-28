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
  city: { front: "#1b2a66", side: "#0f1747", roof: "#3a3f8f", window: "#5cc8ff", recess: "#0a1035", trim: "#8b5cf6" },
  ice: { front: "#b4d8e9", side: "#578ba9", roof: "#e8f5fa", window: "#d9f7ff", recess: "#366781", trim: "#d5edf5" },
  desert: { front: "#d6a36e", side: "#926445", roof: "#f2ca91", window: "#ffd795", recess: "#614432", trim: "#e4ba85" },
} as const;

/** "#1b2a66" + 0.16 -> "rgba(27,42,102,0.16)". Build-time only. */
function rgba(hex: string, alpha: number): string {
  const value = parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${alpha})`;
}

/**
 * Material response shades for the facade pass, derived ONCE from MATERIALS
 * above — no new palette, no per-frame colour construction, no randomness.
 * Each entry is a finished rgba() string used directly as a fillStyle:
 *
 *   tone[0..3]  per-building material mix (front / side / recess / roof) so
 *               neighbouring blocks stop reading as one repeated flat panel;
 *   panel       recessed mullion + floor-slab shadow (window-bay relief);
 *   corner      ambient occlusion on the street-side corner of each block;
 *   rim         the light that catches that same corner edge;
 *   sideUpper   sky-lit upper band of the side wall (fake vertical gradient
 *               without creating a per-building gradient object each frame);
 *   sideLower   ground-contact shading on the lower side wall.
 */
type FacadeShades = {
  tone: readonly [string, string, string, string];
  panel: string;
  corner: string;
  rim: string;
  sideUpper: string;
  sideLower: string;
};

function buildFacadeShades(): Record<string, FacadeShades> {
  const shades: Record<string, FacadeShades> = {};
  for (const [id, material] of Object.entries(MATERIALS)) {
    shades[id] = {
      tone: [
        rgba(material.front, 0.1),
        rgba(material.side, 0.16),
        rgba(material.recess, 0.12),
        rgba(material.roof, 0.07),
      ],
      panel: rgba(material.recess, 0.34),
      corner: rgba(material.recess, 0.3),
      rim: rgba(material.roof, 0.45),
      sideUpper: rgba(material.roof, 0.12),
      sideLower: rgba(material.recess, 0.2),
    };
  }
  return shades;
}

const FACADE_SHADES = buildFacadeShades();

/** Cached conversions of a theme colour string to a partially transparent
 * one (used by the aerial-perspective band). The cache is bounded by the
 * handful of (colour, alpha) pairs the renderer actually asks for. */
const TRANSLUCENT = new Map<string, string>();
function translucent(color: string, alpha: number): string {
  const key = `${color}|${alpha}`;
  const cached = TRANSLUCENT.get(key);
  if (cached) return cached;
  let out = color;
  if (color.startsWith("#")) {
    out = rgba(color, alpha);
  } else {
    const parts = color.match(/rgba?\(([^)]+)\)/);
    if (parts) {
      const channels = parts[1].split(",").map((part) => parseFloat(part));
      out = `rgba(${channels[0]},${channels[1]},${channels[2]},${alpha})`;
    }
  }
  TRANSLUCENT.set(key, out);
  return out;
}

// Mip levels are built once per decoded atlas, not once per building/frame.
// They avoid repeatedly minifying a 512x768 texture into subpixel far walls.
const mipmaps = new WeakMap<object, CanvasImageSource[]>();
function imageWidth(source: CanvasImageSource): number {
  const image = source as HTMLImageElement;
  return image.naturalWidth || image.width || 0;
}
function imageHeight(source: CanvasImageSource): number {
  const image = source as HTMLImageElement;
  return image.naturalHeight || image.height || 0;
}
function facadeMip(source: CanvasImageSource, height: number): CanvasImageSource {
  if (typeof document === "undefined") return source;
  let levels = mipmaps.get(source);
  if (!levels) {
    levels = [source];
    let w = imageWidth(source), h = imageHeight(source);
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
 * Two floors-worth of the facade atlas stacked vertically, built once per
 * decoded atlas. A tall tower samples this so its floors and window bays
 * keep a believable size in world units instead of one 768px atlas being
 * stretched over a 1000-unit wall. Falls back to the plain atlas (1 rep)
 * wherever no canvas is available, so behaviour degrades, never breaks.
 */
export const FACADE_TOWER_REPS = 2;
interface TowerTexture { image: CanvasImageSource; reps: number }
const towers = new WeakMap<object, TowerTexture>();
function towerTexture(source: CanvasImageSource): TowerTexture {
  let tower = towers.get(source);
  if (tower) return tower;
  tower = { image: source, reps: 1 };
  const w = imageWidth(source), h = imageHeight(source);
  if (typeof document !== "undefined" && w > 0 && h > 0) {
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h * FACADE_TOWER_REPS;
    const context = canvas.getContext("2d");
    if (context && typeof context.drawImage === "function") {
      for (let i = 0; i < FACADE_TOWER_REPS; i++) context.drawImage(source, 0, i * h, w, h);
      tower = { image: canvas, reps: FACADE_TOWER_REPS };
    }
  }
  towers.set(source, tower);
  return tower;
}

/**
 * Cells of the per-world decor atlas (city: MPGR signs, ice/desert: cloth
 * banners), in atlas pixels. The renderer projects one cell onto a
 * road-facing wall as depth-correct strips.
 */
export const DECOR_CELLS = {
  city: [
    { x: 0, y: 0, w: 256, h: 192 },
    { x: 256, y: 0, w: 256, h: 192 },
    { x: 0, y: 192, w: 128, h: 192 },
    { x: 128, y: 192, w: 128, h: 192 },
  ],
  ice: [{ x: 0, y: 0, w: 128, h: 256 }, { x: 128, y: 0, w: 128, h: 256 }],
  desert: [{ x: 0, y: 0, w: 128, h: 256 }, { x: 128, y: 0, w: 128, h: 256 }],
} as const;

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
  // Environment-upgrade options (all optional; defaults reproduce the old call shape).
  decor: CanvasImageSource | null = null, // MPGR sign / banner atlas (see DECOR_CELLS)
  salt = 0, // second street row: different heights/profiles from the same slots
  minZ = -Infinity, // skip walls nearer than this depth (cheap far-only rows)
  widen = 1, // lateral block width multiplier for far side rows on wide screens
  rowFog = 0, // extra atmospheric tint for deeper building rows (0 = roadside row)
): void {
  const material = MATERIALS[theme.id];
  const shades = FACADE_SHADES[theme.id];
  const center = width / 2 - cameraLateral;
  const residue = ((-traveled % STREET_SPACING) + STREET_SPACING) % STREET_SPACING;
  for (let i = STREET_BLOCKS - 1; i >= 0; i--) {
    const z = residue + i * STREET_SPACING - 160;
    if (z < minZ) continue;
    const index = Math.round((z + traveled + 160) / STREET_SPACING);
    const hk = salt ? index ^ Math.imul(salt, 0x9e3779b1) : index;
    const farZ = z + STREET_SPACING * (0.72 + streetHash(hk, 119) * 0.19);
    const nearS = streetScale(z), farS = streetScale(farZ);
    const groundNear = streetGround(height, z), groundFar = streetGround(height, farZ);
    for (let side = -1; side <= 1; side += 2) {
      const r = streetHash(hk, side + 83);
      // Independently salted profiles: rare landmarks reuse a street slot,
      // never add objects or consume the authoritative random stream.
      const profile = streetHash(hk, side < 0 ? 401 : 719);
      const landmark = profile > 0.955;
      const totalHeight = height * (0.25 + r * r * 0.78) * (landmark ? 1.12 : 1);
      const stepped = r > 0.68; // keep the existing number of upper volumes
      const buildingHeight = totalHeight * (stepped ? 0.64 + profile * 0.13 : 1);
      const inner = side * (trackHalf + height * (0.045 + streetHash(hk, side + 12) * 0.018));
      const outer = inner + side * height * (0.10 + streetHash(hk, side + 17) * 0.17) * (landmark ? 1.08 : 1) * widen;
      const xn = center + inner * nearS, xf = center + inner * farS;
      const xo = center + outer * nearS, xof = center + outer * farS;
      if (Math.min(xn, xf, xo, xof) > width + 4 || Math.max(xn, xf, xo, xof) < -4) continue;
      const yn = groundNear - buildingHeight * nearS, yf = groundFar - buildingHeight * farS;
      const fog = Math.min(0.92, Math.max(0, z) / 6000 + rowFog);
      // AO contact footprint stays on the same ground plane as the wall.
      ctx.fillStyle = theme.id === "ice" ? "rgba(25,60,80,0.14)" : theme.id === "desert" ? "rgba(65,40,20,0.18)" : "rgba(5,12,20,0.22)";
      quad(ctx, xn - side * 9 * nearS, groundNear, xo, groundNear, xof, groundFar, xf - side * 9 * farS, groundFar);
      // A second, inset solid volume on selected roofs. Its base is exactly
      // the main roof plane; verticals share x at top/bottom, never lean.
      // Two faces, cached atlas detail and fog; no filters/scene objects.
      if (stepped) {
        const upperInner = inner + (outer - inner) * (0.18 + profile * 0.16);
        const upperOuter = outer - (outer - inner) * (0.09 + streetHash(hk, side + 331) * 0.13);
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
        // Texture sampling is WORLD-SCALED: the source window is sized from
        // the wall's depth/height in world units (floors stay floor-sized,
        // bays stay bay-sized) and anchored to the ground floor, instead of
        // one atlas being stretched over the whole wall.
        const tower = towerTexture(texture);
        const mappedTexture = facadeMip(tower.image, buildingHeight * nearS / tower.reps);
        const iw = imageWidth(mappedTexture), ih = imageHeight(mappedTexture);
        const unitsAcross = Math.max(height * 0.2, 190); // world units per atlas width
        const unitsUp = height * 0.4; // world units per atlas height
        const rows = Math.min(1, buildingHeight / unitsUp / tower.reps);
        const sh = ih * Math.max(0.12, rows);
        const sy = ih - sh;
        const wallDepth = Math.max(1, farZ - z);
        const cols = Math.min(1, wallDepth / unitsAcross);
        const moduleWidth = landmark ? Math.min(cols, 0.5) : cols;
        const moduleStart = (1 - moduleWidth) * streetHash(hk, side + 92);
        const slices = Math.max(2, Math.min(12, Math.ceil(Math.abs(xn - xf) / 5)));
        ctx.save();
        ctx.beginPath(); ctx.moveTo(xn, yn); ctx.lineTo(xf, yf); ctx.lineTo(xf, groundFar); ctx.lineTo(xn, groundNear); ctx.closePath(); ctx.clip();
        for (let slice = 0; slice < slices; slice++) {
          const a = slice / slices, b = (slice + 1) / slices;
          const sa = streetScale(z + (farZ - z) * a), sb = streetScale(z + (farZ - z) * b);
          const xa = center + inner * sa, xb = center + inner * sb;
          const sm = (sa + sb) / 2;
          const top = height * (STREET_HORIZON + (STREET_GROUND - STREET_HORIZON) * sm) - buildingHeight * sm;
          ctx.drawImage(mappedTexture, iw * (moduleStart + moduleWidth * a), sy, iw * moduleWidth / slices, sh, Math.min(xa, xb), top, Math.abs(xa - xb) + 0.5, buildingHeight * sm);
        }
        ctx.restore();
        const frontCols = Math.min(1, Math.abs(outer - inner) / unitsAcross);
        const frontStart = (1 - frontCols) * streetHash(hk, side + 93);
        ctx.drawImage(mappedTexture, iw * frontStart, sy, iw * frontCols, sh, Math.min(xn, xo), yn, Math.abs(xo - xn), groundNear - yn);
        ctx.globalAlpha = 0.23 + profile * 0.18 + (theme.id === "city" ? 0.16 : 0);
        ctx.fillStyle = material.side;
        quad(ctx, xn, yn, xo, yn, xo, groundNear, xn, groundNear);
        ctx.globalAlpha = 1;
      }

      // --- Material depth pass (final polish) -----------------------------
      // Bounded, image-free and deterministic: no new assets, no gradient
      // object built per building, no randomness outside streetHash. This is
      // what stops the solid street reading as flat poster panels — a
      // per-building material mix, a shaded street-side corner with its own
      // rim light, recessed window-bay mullions and floor slabs, and a
      // two-tone side wall standing in for a real vertical light gradient.
      const wallW = xo - xn;
      ctx.fillStyle = shades.tone[Math.min(3, Math.floor(r * 4))];
      quad(ctx, xn, yn, xf, yf, xf, groundFar, xn, groundNear); // side wall (recedes)
      quad(ctx, xn, yn, xo, yn, xo, groundNear, xn, groundNear); // road-facing wall
      if (z < 1800) {
        // Two-tone side wall: sky-lit upper band, ground-shaded lower band.
        ctx.fillStyle = shades.sideUpper;
        quad(ctx, xn, yn, xf, yf, xf, yf + (groundFar - yf) * 0.42, xn, yn + (groundNear - yn) * 0.42);
        ctx.fillStyle = shades.sideLower;
        quad(ctx, xn, groundNear - (groundNear - yn) * 0.26, xf, groundFar - (groundFar - yf) * 0.26, xf, groundFar, xn, groundNear);
        // Street-side corner: ambient occlusion on the wall, rim light on the
        // edge itself, so the corner reads as a real corner from any depth.
        ctx.fillStyle = shades.corner;
        quad(ctx, xn, yn, xn + wallW * 0.12, yn, xn + wallW * 0.12, groundNear, xn, groundNear);
        ctx.strokeStyle = shades.rim;
        ctx.lineWidth = 1.1;
        ctx.beginPath(); ctx.moveTo(xn, yn); ctx.lineTo(xn, groundNear); ctx.stroke();
        if (texture && z < 1500) {
          // Recessed window bays: a shaded mullion with a lit reveal beside
          // it every quarter of the wall run, plus three projected floor
          // slabs with their own lit edge. All on the side wall's own plane.
          for (let m = 1; m <= 3; m++) {
            const zM = z + (farZ - z) * (m / 4);
            const sM = streetScale(zM);
            const xM = center + inner * sM;
            const gM = streetGround(height, zM);
            const hM = buildingHeight * sM;
            ctx.fillStyle = shades.panel;
            ctx.fillRect(xM - 0.5, gM - hM, 1.2, hM);
            ctx.fillStyle = shades.rim;
            ctx.fillRect(xM + 1.1, gM - hM, 0.9, hM);
          }
          ctx.lineWidth = Math.max(0.4, nearS * 0.8);
          for (let k = 1; k <= 3; k++) {
            const level = buildingHeight * (k / 4);
            ctx.strokeStyle = shades.panel;
            ctx.beginPath();
            ctx.moveTo(xn, groundNear - level * nearS);
            ctx.lineTo(xf, groundFar - level * farS);
            ctx.stroke();
            ctx.strokeStyle = shades.rim;
            ctx.beginPath();
            ctx.moveTo(xn, groundNear - (level + 1.2) * nearS);
            ctx.lineTo(xf, groundFar - (level + 1.2) * farS);
            ctx.stroke();
          }
        }
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
          const lit = streetHash(hk * 103 + row * 7 + col, side + 50);
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
      // --- Lighting & material response (presentation only) -----------------
      // Ambient occlusion where the wall meets the street, then a lit upper
      // band from the sky, both on the road-facing wall's own plane.
      if (z < 2600) {
        ctx.fillStyle = material.recess;
        ctx.globalAlpha = 0.34 * (1 - fog);
        quad(ctx, xn, groundNear - buildingHeight * 0.16 * nearS, xf, groundFar - buildingHeight * 0.16 * farS, xf, groundFar, xn, groundNear);
        ctx.fillStyle = material.roof;
        ctx.globalAlpha = 0.11 * (1 - fog);
        quad(ctx, xn, yn, xf, yf, xf, groundFar - buildingHeight * 0.8 * farS, xn, groundNear - buildingHeight * 0.8 * nearS);
        ctx.globalAlpha = 1;
      }
      // Emissive courses: two light strips that recede with the wall, plus a
      // lit corner edge. City neon, ice-crystal glow, desert lantern amber.
      if (z < 2200 && (theme.id === "city" ? r > 0.28 : r > 0.62)) {
        const pulse = 0.82 + 0.18 * Math.sin(elapsed / 900 + hk * 1.7);
        ctx.strokeStyle = theme.curbEdge;
        ctx.lineWidth = Math.max(0.6, (theme.id === "desert" ? 1.1 : 1.7) * nearS);
        ctx.globalAlpha = (theme.id === "desert" ? 0.4 : 0.62) * pulse * (1 - fog);
        for (let course = 0; course < 2; course++) {
          const level = buildingHeight * (course === 0 ? 0.34 : 0.68);
          ctx.beginPath();
          ctx.moveTo(xn, groundNear - level * nearS);
          ctx.lineTo(xf, groundFar - level * farS);
          ctx.stroke();
        }
        ctx.globalAlpha = 0.5 * pulse * (1 - fog);
        ctx.beginPath(); ctx.moveTo(xn, yn); ctx.lineTo(xn, groundNear); ctx.stroke();
        ctx.globalAlpha = 1;
      }
      // MPGR signage / banners projected onto the road-facing wall as
      // depth-correct strips (real branded art, no free-floating cards).
      if (decor && z < 1500 && streetHash(hk, side + 61) > 0.5) {
        const cells = DECOR_CELLS[theme.id];
        const cell = cells[Math.floor(streetHash(hk, side + 62) * cells.length) % cells.length];
        const mount = buildingHeight * 0.16;
        const wanted = theme.id === "city" ? height * 0.13 : height * 0.15;
        const signH = Math.min(wanted * cell.h / 192 * (theme.id === "city" ? 1 : 0.9), buildingHeight * 0.66);
        const signW = signH * cell.w / cell.h;
        const z0 = z + (farZ - z) * (0.08 + 0.2 * streetHash(hk, side + 63));
        const z1 = Math.min(farZ - 4, z0 + signW);
        if (z1 > z0 + 6 && signH > 4) {
          const n = z < 600 ? 4 : 2;
          const glow = theme.id === "city" ? theme.rail : theme.curbEdge;
          ctx.fillStyle = glow;
          ctx.globalAlpha = 0.16 * (1 - fog);
          const g0 = streetScale(z0), g1 = streetScale(z1);
          quad(ctx, center + inner * g0, streetGround(height, z0) - (mount - 5) * g0, center + inner * g1, streetGround(height, z1) - (mount - 5) * g1,
            center + inner * g1, streetGround(height, z1) - (mount + signH + 5) * g1, center + inner * g0, streetGround(height, z0) - (mount + signH + 5) * g0);
          ctx.globalAlpha = 1 - fog * 0.6;
          for (let i = 0; i < n; i++) {
            const za = z0 + (z1 - z0) * i / n, zb = z0 + (z1 - z0) * (i + 1) / n;
            const sa = streetScale(za), sb = streetScale(zb), sm = (sa + sb) / 2;
            const xa = center + inner * sa, xb = center + inner * sb;
            const gy = height * (STREET_HORIZON + (STREET_GROUND - STREET_HORIZON) * sm);
            // Right-hand walls recede right-to-left; read the cell in screen order.
            const f0 = side < 0 ? i / n : 1 - (i + 1) / n;
            ctx.drawImage(decor, cell.x + cell.w * f0, cell.y, cell.w / n, cell.h, Math.min(xa, xb), gy - (mount + signH) * sm, Math.abs(xb - xa) + 0.5, signH * sm);
          }
          ctx.globalAlpha = 1;
        }
      }
      // Pale roof accumulation / sandstone cornice; restrained cyan city trim.
      ctx.strokeStyle = theme.id === "city" && r > 0.78 ? theme.rail : material.roof;
      ctx.lineWidth = (theme.id === "ice" ? 5 : 2) * nearS;
      ctx.beginPath(); ctx.moveTo(xo, yn); ctx.lineTo(xn, yn); ctx.lineTo(xf, yf); ctx.stroke();
      if (theme.id !== "desert" && r > 0.55 && !stepped && !landmark) {
        // Roof mast with a lit tip (city/ice), read against the sky plate.
        ctx.fillStyle = material.trim;
        ctx.fillRect((xn + xo) / 2, yn - 46 * nearS, 2 * nearS, 46 * nearS);
        if (z < 1600) {
          ctx.fillStyle = theme.twinkle[index % 2];
          ctx.globalAlpha = 0.6 + 0.4 * Math.sin(elapsed / 500 + hk);
          ctx.fillRect((xn + xo) / 2 - 1.5 * nearS, yn - 49 * nearS, 5 * nearS, 4 * nearS);
          ctx.globalAlpha = 1;
        }
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
        const plinth = height * (0.016 + streetHash(hk, side + 97) * 0.012);
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

/**
 * Distant district masses between the far street rows and the skyline.
 *
 * The street rows end at a finite depth and the skyline sits on the horizon,
 * which used to leave a bare band of flat ground in between. This band fills
 * exactly that gap with heavily haze-tinted silhouettes, so the eye reads
 * roadside → blocks → districts → skyline as one continuous depth ramp
 * instead of stopping at the last building row.
 *
 * Presentation only, and deliberately cheap: 26 flat quads, no images, no
 * gradients, no per-block objects. Positions come from streetHash, so the
 * band is identical for the same travel distance (deterministic frames,
 * pause-stable) and consumes no gameplay randomness. It is anchored to the
 * HORIZON (not the ground plane) and parallaxes slower than the skyline
 * layers behind it, which is what sells the distance.
 */
export function drawDistantDistricts(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  cameraLateral: number,
  theme: RunWorldTheme,
): void {
  const horizon = height * STREET_HORIZON;
  const span = width + 120;
  for (let i = 0; i < 26; i++) {
    const bx = streetHash(i, 611);
    const bx2 = streetHash(i, 617);
    const bh = streetHash(i, 619);
    const shade = streetHash(i, 631);
    const w = span * (0.018 + bx2 * 0.05);
    // Slow lateral parallax: the camera trails the lane change, and these
    // masses sit far enough away that they must lag the skyline as well.
    const x = -60 + bx * span - cameraLateral * 0.05;
    const tall = horizon * (0.05 + bh * bh * 0.16);
    const base = horizon + 1 + shade * 2;
    ctx.fillStyle = theme.fog;
    ctx.globalAlpha = 0.3 + shade * 0.3;
    quad(ctx, x, base, x + w, base, x + w, base - tall, x, base - tall);
    // Stepped crown on the taller masses only (bounded: 1 extra quad each).
    if (tall > horizon * 0.1) {
      const inset = w * 0.22;
      ctx.globalAlpha = 0.24 + shade * 0.24;
      quad(ctx, x + inset, base - tall, x + w - inset, base - tall, x + w - inset, base - tall - tall * 0.14, x + inset, base - tall - tall * 0.14);
    }
  }
  ctx.globalAlpha = 1;
}

/**
 * Aerial perspective over the far ground.
 *
 * One screen-space band that melts the distant road, shoulder and building
 * bases into the horizon haze. It is strongest at the horizon line and gone
 * before the mid-distance, so the near road — surface material, lane
 * markings, rails, contact shadows — is untouched. The colour comes from the
 * world's own haze so every world keeps its established atmosphere, and the
 * alpha bucket cache keeps this a single gradient fill per frame.
 *
 * The gradient starts just ABOVE the horizon and reaches its peak exactly ON
 * the horizon line: starting at the horizon instead would step the alpha from
 * 0 to full in one pixel and leave a visible seam under the skyline. Above the
 * horizon it is atmosphere over sky, below it is atmosphere over far ground —
 * the same continuous ramp the camera would see through more air.
 */
export function drawGroundAerialFade(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  theme: RunWorldTheme,
): void {
  const horizon = height * STREET_HORIZON;
  const span = (height * (STREET_GROUND - STREET_HORIZON)) * 0.5;
  const above = span * 0.34;
  const total = above + span;
  const fade = ctx.createLinearGradient(0, horizon - above, 0, horizon + span);
  fade.addColorStop(0, translucent(theme.haze, 0));
  fade.addColorStop(above / total, translucent(theme.haze, 0.46));
  fade.addColorStop(above / total + 0.34 * (span / total), translucent(theme.haze, 0.16));
  fade.addColorStop(1, translucent(theme.haze, 0));
  ctx.fillStyle = fade;
  ctx.fillRect(-40, horizon - above, width + 80, total + 1);
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
