import type { RunWorldTheme } from "./run-environments";
import type { RunWorldId } from "./run-assets";

/** Presentation-only street geometry. No random source, clock or simulation writes. */
export const STREET_FOCAL = 300;
export const STREET_HORIZON = 0.54;
export const STREET_GROUND = 0.84;
export const RUNNER_HEIGHT_FRACTION = 0.165;
export const STREET_SPACING = 230;
export const STREET_BLOCKS = 23;

/**
 * The world's street-material light response, for shading the surfaces that sit
 * beside the facades (pavement, kerbs, contact bands). Kept here so the palette
 * has exactly one source of truth; the renderer never invents colours.
 */
export function streetTones(themeId: RunWorldId): { sheen: string; shadow: string; bounce: string } {
  const material = MATERIALS[themeId];
  return { sheen: material.sheen, shadow: material.shadow, bounce: material.bounce };
}

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

/**
 * Street materials. Tone variants are literal, precomputed strings: picking
 * one per block by hash gives neighbouring buildings different massing
 * colour without any per-frame colour arithmetic, mixing or allocation.
 *
 *   front/side/roof — the three visible prism faces
 *   sheen           — cool sky/glass response laid over the road-facing wall
 *   bounce          — street light kicked back onto the wall base
 *   shadow          — vertical falloff colour for the lower wall
 */
interface StreetMaterial {
  front: string;
  side: string;
  roof: string;
  window: string;
  recess: string;
  trim: string;
  sheen: string;
  bounce: string;
  shadow: string;
  frontVariants: readonly string[];
  sideVariants: readonly string[];
}

const MATERIALS: Record<RunWorldId, StreetMaterial> = {
  city: {
    front: "#1b2a66", side: "#0f1747", roof: "#3a3f8f", window: "#5cc8ff",
    recess: "#0a1035", trim: "#8b5cf6", sheen: "#9ED4FF", bounce: "#6AA8FF", shadow: "#0B123A",
    frontVariants: ["#17244f", "#1b2a66", "#1f3070", "#22377c"],
    sideVariants: ["#0c1340", "#0f1747", "#111c4f", "#142156"],
  },
  ice: {
    front: "#b4d8e9", side: "#578ba9", roof: "#e8f5fa", window: "#d9f7ff",
    recess: "#366781", trim: "#d5edf5", sheen: "#F2FCFF", bounce: "#E4F6FF", shadow: "#3E7695",
    frontVariants: ["#a6cde0", "#b4d8e9", "#bfe0ee", "#c9e7f2"],
    sideVariants: ["#4b7d99", "#578ba9", "#6193b0", "#6b9db9"],
  },
  desert: {
    front: "#d6a36e", side: "#926445", roof: "#f2ca91", window: "#ffd795",
    recess: "#614432", trim: "#e4ba85", sheen: "#FFEDCB", bounce: "#F5CE96", shadow: "#6E4A31",
    frontVariants: ["#c8965f", "#d6a36e", "#dfad79", "#e6b785"],
    sideVariants: ["#855838", "#926445", "#9d6f4d", "#a87956"],
  },
};

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
  atmosphere = 0, // extra aerial haze for outer rows: pushes them behind the street
): void {
  const material = MATERIALS[theme.id];
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
      // Neighbouring masses read as separate buildings: each block picks its
      // own precomputed tone variant for the road-facing and section faces.
      const tone = streetHash(hk, side + 211);
      const frontTone = material.frontVariants[(tone * material.frontVariants.length) | 0];
      const sideTone = material.sideVariants[(streetHash(hk, side + 233) * material.sideVariants.length) | 0];
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
      // Aerial perspective: depth haze plus the row's own atmosphere offset,
      // so the outer rows genuinely sit behind the roadside row instead of
      // reading as a second copy at the same distance.
      const fog = Math.min(0.9, Math.max(0, z) / 6000 + atmosphere);
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
      facade.addColorStop(0, frontTone);
      facade.addColorStop(1, sideTone);
      ctx.fillStyle = facade;
      quad(ctx, xn, yn, xf, yf, xf, groundFar, xn, groundNear);
      ctx.fillStyle = sideTone;
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
        ctx.fillStyle = sideTone;
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
      // --- Facade depth: recessed panels, face shading, corner light --------
      // Near blocks get cheap cues that make a projected wall read as a solid
      // volume instead of a card: recessed cladding bands with lit sills, a
      // sky->street shading ramp on the road-facing wall, a lit near corner
      // where the wall turns toward the street, and a faint wet-road bounce
      // below its own contact line. Every quad stays on the wall's own ground
      // plane (nothing floats or leans), and the pass is depth gated so far
      // blocks keep their flat atmospheric colour.
      if (z < 1100 && atmosphere === 0) {
        const near = 1 - Math.min(1, Math.max(0, z) / 1100);
        const third = buildingHeight / 3;
        // Vertical shading: sky light high on the wall, occlusion toward the
        // street. Two flat quads, no per-frame gradients.
        ctx.fillStyle = material.sheen;
        ctx.globalAlpha = 0.07 * near * (1 - fog);
        quad(ctx, xn, yn, xf, yf, xf, groundFar - (buildingHeight - third) * farS, xn, groundNear - (buildingHeight - third) * nearS);
        ctx.fillStyle = material.shadow;
        ctx.globalAlpha = 0.15 * near * (1 - fog);
        quad(ctx, xn, groundNear - third * nearS, xf, groundFar - third * farS, xf, groundFar, xn, groundNear);
        // Recessed cladding bands + sill catch-light (max 3 bands per wall).
        const bands = z < 620 ? 3 : 2;
        for (let band = 1; band <= bands; band++) {
          const level = buildingHeight * (band / (bands + 1.4));
          const hN = groundNear - level * nearS, hF = groundFar - level * farS;
          const depthN = buildingHeight * 0.055 * nearS, depthF = buildingHeight * 0.055 * farS;
          ctx.fillStyle = material.recess;
          ctx.globalAlpha = 0.2 * near * (1 - fog);
          quad(ctx, xn, hN - depthN, xf, hF - depthF, xf, hF, xn, hN);
          ctx.fillStyle = material.sheen;
          ctx.globalAlpha = 0.11 * near * (1 - fog);
          quad(ctx, xn, hN, xf, hF, xf, hF + depthN * 0.22, xn, hN + depthN * 0.22);
        }
        // Lit near corner where the wall meets the street-side edge.
        ctx.fillStyle = material.bounce;
        ctx.globalAlpha = 0.15 * near * (1 - fog);
        quad(ctx, xn, yn, xn + side * 2.6 * nearS, yn, xn + side * 2.6 * nearS, groundNear, xn, groundNear);
        ctx.globalAlpha = 1;
        // Wet-road bounce (city/ice): the facade continues faintly below its
        // contact line, inside the block's own lateral footprint.
        if (theme.id !== "desert") {
          const bounce = buildingHeight * 0.22;
          ctx.fillStyle = material.bounce;
          ctx.globalAlpha = 0.055 * near * (1 - fog);
          quad(ctx, xn, groundNear, xo, groundNear, xo + side * 3 * nearS, groundNear + bounce * nearS, xn + side * 3 * nearS, groundNear + bounce * nearS);
        }
        ctx.globalAlpha = 1;
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

/**
 * Distant district mass. A hazy band of wider, lower blocks that fills the
 * wedge between the roadside street wall and the horizon skyline, so the road
 * recedes into a continuous city instead of ending in an empty valley at the
 * vanishing point. Same rules as the street: solid prisms on the shared ground
 * plane, deterministic per-slot profiles, heavy aerial haze, no texture
 * sampling, no allocations and a fixed block count.
 */
export function drawDistantDistrict(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  trackHalf: number,
  cameraLateral: number,
  traveled: number,
  theme: RunWorldTheme,
  atmosphere = 0.42,
  spacing = 520,
  blocks = 10,
  minZ = 2500,
): void {
  const material = MATERIALS[theme.id];
  const center = width / 2 - cameraLateral;
  const residue = ((-traveled % spacing) + spacing) % spacing;
  for (let i = blocks - 1; i >= 0; i--) {
    const z = residue + (i + Math.ceil(minZ / spacing)) * spacing;
    const index = Math.round((z + traveled) / spacing);
    const hk = index ^ Math.imul(37, 0x9e3779b1);
    const r = streetHash(hk, 811);
    const farZ = z + spacing * 1.3;
    const nearS = streetScale(z), farS = streetScale(farZ);
    if (nearS <= 0.02) continue;
    const groundNear = streetGround(height, z), groundFar = streetGround(height, farZ);
    const fog = Math.min(0.94, z / 6000 + atmosphere);
    for (let side = -1; side <= 1; side += 2) {
      const totalHeight = height * (0.14 + r * r * 0.46) * (0.85 + streetHash(hk, side + 3) * 0.3);
      const inner = side * (trackHalf + height * (0.12 + streetHash(hk, side + 5) * 0.26));
      const outer = inner + side * height * (0.2 + streetHash(hk, side + 9) * 0.55);
      const xn = center + inner * nearS, xf = center + inner * farS;
      const xo = center + outer * nearS, xof = center + outer * farS;
      if (Math.min(xn, xf, xo, xof) > width + 4 || Math.max(xn, xf, xo, xof) < -4) continue;
      const yn = groundNear - totalHeight * nearS, yf = groundFar - totalHeight * farS;
      // Beyond this much haze a block is a silhouette: one hazed shape instead
      // of three shaded faces, which keeps the far district nearly free while
      // the near half keeps its volume and lit windows.
      if (fog > 0.72) {
        ctx.fillStyle = theme.fog;
        ctx.globalAlpha = Math.min(0.96, fog);
        quad(ctx, xn, yn, xo, yn, xof, yf, xf, yf);
        quad(ctx, xn, yn, xf, yf, xf, groundFar, xn, groundNear);
        ctx.globalAlpha = 1;
        continue;
      }
      // Section face, roof plane, then the road-facing wall: one silhouette
      // per block, all sharing the block's projected ground line.
      ctx.fillStyle = material.side;
      quad(ctx, xn, yn, xo, yn, xo, groundNear, xn, groundNear);
      ctx.fillStyle = material.roof;
      quad(ctx, xn, yn, xo, yn, xof, yf, xf, yf);
      ctx.fillStyle = material.front;
      quad(ctx, xn, yn, xf, yf, xf, groundFar, xn, groundNear);
      // Haze pass: solid geometry tints toward the world's atmospheric fill
      // rather than fading to transparency.
      ctx.fillStyle = theme.fog;
      ctx.globalAlpha = fog;
      quad(ctx, xn, yn, xo, yn, xo, groundNear, xn, groundNear);
      quad(ctx, xn, yn, xo, yn, xof, yf, xf, yf);
      quad(ctx, xn, yn, xf, yf, xf, groundFar, xn, groundNear);
      // Sparse lit windows keep the far district alive without texture work.
      if (fog < 0.72) {
        const wallW = Math.abs(xf - xn);
        const wallX = Math.min(xn, xf);
        const midS = (nearS + farS) / 2;
        const midGround = streetGround(height, (z + farZ) / 2);
        ctx.fillStyle = material.window;
        ctx.globalAlpha = 0.2 * (1 - fog);
        const dotW = Math.max(0.8, wallW * 0.14);
        const dotH = Math.max(0.8, height * 0.004 * midS);
        for (let row = 1; row <= 3; row++) {
          const level = totalHeight * (row / 4);
          ctx.fillRect(
            wallX + wallW * streetHash(hk * 31 + row, side + 17) * 0.74,
            midGround - level * midS,
            dotW,
            dotH,
          );
        }
      }
      ctx.globalAlpha = 1;
    }
  }
}

function quad(ctx: CanvasRenderingContext2D, ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): void {
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(cx, cy); ctx.lineTo(dx, dy); ctx.closePath(); ctx.fill();
}

/**
 * Kerb dressing. World-locked pavement joints run across each kerb band and a
 * kerb-top highlight runs along its outer edge, both projected through the same
 * depth scale as the bands they sit on, so the shoulder reads as pavement
 * meeting the road instead of a flat coloured wedge. Fixed 18 joints per side,
 * deterministic spacing, no texture sampling and no allocations.
 */
export function drawPavementDetail(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  trackHalf: number,
  cameraLateral: number,
  traveled: number,
  theme: RunWorldTheme,
): void {
  const material = MATERIALS[theme.id];
  const center = width / 2 - cameraLateral;
  const inner = trackHalf + 5;
  const outer = trackHalf + 64;
  const spacing = 150;
  const residue = ((-traveled % spacing) + spacing) % spacing;
  const jointAlpha = theme.id === "ice" ? 0.5 : theme.id === "desert" ? 0.34 : 0.42;
  for (let i = 0; i < 9; i++) {
    const z = residue + i * spacing;
    const s = streetScale(z);
    if (s <= 0.03 || s > 2.6) continue;
    const y = streetGround(height, z);
    const thickness = Math.max(0.4, 2.2 * s);
    const fade = Math.min(1, s * 1.6) * (1 - Math.min(0.7, z / 5200));
    for (let side = -1; side <= 1; side += 2) {
      // Lit seam across the pavement: the inner slab catches the road light and
      // the outer third falls into facade shade, so the joint reads as a
      // surface joint rather than a painted line.
      ctx.fillStyle = material.sheen;
      ctx.globalAlpha = jointAlpha * fade * 0.34;
      quad(ctx, center + side * inner * s, y, center + side * (inner + 22) * s, y,
        center + side * (inner + 22) * s, y + thickness, center + side * inner * s, y + thickness);
      ctx.fillStyle = material.shadow;
      ctx.globalAlpha = jointAlpha * fade * 0.3;
      quad(ctx, center + side * (inner + 22) * s, y, center + side * (outer - 18) * s, y,
        center + side * (outer - 18) * s, y + thickness, center + side * (inner + 22) * s, y + thickness);
    }
  }
  ctx.globalAlpha = 1;
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
