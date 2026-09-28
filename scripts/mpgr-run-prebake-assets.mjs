// Offline preparation/verification only; no app route or production dependency.
// npm install --prefix /tmp/mpgr-visual esbuild @napi-rs/canvas sharp
// MPGR_VISUAL_TOOLS=/tmp/mpgr-visual node scripts/mpgr-run-prebake-assets.mjs [--write]
// Default is verify-only. --write regenerates the four derivative files.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tools = createRequire(path.join(process.env.MPGR_VISUAL_TOOLS || root, 'package.json'));
const { build } = tools('esbuild');
const { createCanvas, loadImage } = tools('@napi-rs/canvas');
const sharp = tools('sharp');
const write = process.argv.includes('--write');
const temporary = await mkdtemp(path.join(tmpdir(), 'mpgr-prebake-'));
const disk = relative => path.join(root, 'public', relative);
try {
  const bundle = path.join(temporary, 'strip.mjs');
  await build({ stdin: { contents: 'export { stripBackgroundToTransparent } from "./lib/games/mpgr-run/run-render";', resolveDir: root, loader: 'ts' },
    outfile: bundle, bundle: true, platform: 'node', format: 'esm', tsconfig: path.join(root, 'tsconfig.json') });
  const { stripBackgroundToTransparent } = await import(pathToFileURL(bundle).href);
  globalThis.document = { createElement: () => createCanvas(1, 1) };
  const cutouts = [];
  for (const source of [
    '/games/mpgr-run/character/mpgr-runner-run-2.webp',
    '/games/mpgr-run/collectibles/mpgr-run-treasure-chest.webp',
    '/games/mpgr-run/checkpoints/mpgr-run-checkpoint.webp',
  ]) {
    const canvas = stripBackgroundToTransparent(await loadImage(disk(source)));
    const { width, height } = canvas;
    const rgba = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    const output = source.replace('.webp', '-cutout.webp');
    if (write) await sharp(Buffer.from(rgba), { raw: { width, height, channels: 4 } }).webp({ lossless: true }).toFile(disk(output));
    const decoded = await sharp(disk(output)).ensureAlpha().raw().toBuffer();
    let mismatches = decoded.length === rgba.length ? 0 : 1;
    for (let i = 0; i < rgba.length; i += 4) {
      if (decoded[i + 3] !== rgba[i + 3]) mismatches++;
      // RGB underneath fully transparent pixels is not preserved by WebP.
      if (rgba[i + 3] && (decoded[i] !== rgba[i] || decoded[i + 1] !== rgba[i + 1] || decoded[i + 2] !== rgba[i + 2])) mismatches++;
    }
    if (mismatches) throw new Error(`${output}: ${mismatches} visible-pixel/alpha mismatches`);
    cutouts.push({ source, output, width, height, visiblePixelAndAlphaMismatches: mismatches,
      sourceSha256: createHash('sha256').update(await readFile(disk(source))).digest('hex') });
  }
  const source = '/games/mpgr-run/environment/city/city-skyline.webp';
  const output = '/games/mpgr-run/environment/city/city-skyline-atmospheric.webp';
  const { data, info } = await sharp(disk(source)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let changedPixels = 0;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const i = (y * info.width + x) * 4;
    const mix = Math.max(0, Math.min(1, (0.72 - y / info.height) / 0.32));
    if (data[i + 3] && mix > 0) {
      const r = data[i], g = data[i + 1], b = data[i + 2], lum = r * 0.2126 + g * 0.7152 + b * 0.0722;
      data[i] = r * (1 - mix) + lum * 0.68 * mix;
      data[i + 1] = g * (1 - mix) + lum * 0.91 * mix;
      data[i + 2] = b * (1 - mix) + lum * 1.1 * mix;
      changedPixels++;
    }
  }
  // Grade atmospheric upper buildings toward blue-grey; preserve every
  // alpha byte and the original file. No destructive silhouette extraction.
  if (write) await sharp(data, { raw: info }).webp({ lossless: true }).toFile(disk(output));
  const decoded = await sharp(disk(output)).ensureAlpha().raw().toBuffer();
  if (decoded.length !== data.length) throw new Error('Skyline dimensions changed');
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] !== decoded[i + 3] || (data[i + 3] && (data[i] !== decoded[i] || data[i + 1] !== decoded[i + 1] || data[i + 2] !== decoded[i + 2]))) throw new Error('Skyline derivative mismatch');
  }
  console.log(JSON.stringify({ cutouts, citySkyline: { source, output, changedPixels, alphaUnchanged: true } }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
