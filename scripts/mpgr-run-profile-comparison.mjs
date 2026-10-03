// Native software comparison, NOT phone FPS/INP. Never changes Git branches.
// npm install --prefix /tmp/mpgr-visual esbuild @napi-rs/canvas
// MPGR_VISUAL_TOOLS=/tmp/mpgr-visual node scripts/mpgr-run-profile-comparison.mjs /tmp/comparison.json
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tools = createRequire(path.join(process.env.MPGR_VISUAL_TOOLS || root, 'package.json'));
const { build } = tools('esbuild'), { createCanvas, loadImage } = tools('@napi-rs/canvas');
const temporary = await mkdtemp(path.join(tmpdir(), 'mpgr-comparison-'));
const rows = [];
globalThis.document = { createElement: () => createCanvas(1, 1) };
try {
  for (const [mode, ref] of [['pr62', '5489ea0d978f6c1e39f824d934c58bc5db97cf02'], ['prepolish', '05fa9538d3f920a0de1f3371fd08f104dae8e4cd'], ['current', null]]) {
    const bundle = path.join(temporary, mode + '.mjs');
    await build({ stdin: { contents: ['run-render', 'run-assets', 'run-world', 'run-config'].map(name => `export * from "./lib/games/mpgr-run/${name}";`).join('\n'), resolveDir: root, loader: 'ts' },
      outfile: bundle, bundle: true, platform: 'node', format: 'esm', tsconfig: path.join(root, 'tsconfig.json'),
      plugins: ref ? [{ name: 'read-baseline-without-checkout', setup(b) {
        b.onLoad({ filter: /\.ts$/ }, args => {
          const relative = path.relative(root, args.path);
          if (relative.startsWith('..') || relative.startsWith('node_modules/')) return;
          // A missing baseline module is an error, not a mixed-revision fallback.
          return { contents: execFileSync('git', ['show', `${ref}:${relative}`], { cwd: root, encoding: 'utf8' }), loader: 'ts' };
        });
      } }] : [],
    });
    const game = await import(pathToFileURL(bundle).href), images = new Map();
    for (const src of game.ALL_SPRITE_PATHS) images.set(src, await loadImage(path.join(root, 'public', src.split('?')[0])));
    for (const [scene, meters] of [['city', 120], ['ice', 620], ['desert', 1060]]) for (const [width, height] of [[390, 844], [1280, 720]]) {
      const canvas = createCanvas(width, height), ctx = canvas.getContext('2d'), world = game.freshWorld();
      world.elapsedMs = 6000; world.traveledPx = meters * game.PX_PER_METER;
      world.obstacles = [{ id: 101, ...game.OBSTACLE_TYPES.crate, type: 'crate', lane: 0, x: 390, hit: false, passed: false },
        { id: 102, ...game.OBSTACLE_TYPES.barrier, type: 'barrier', lane: 2, x: 640, hit: false, passed: false }];
      world.collectibles = Array.from({ length: 7 }, (_, i) => ({ id: 201 + i, type: 'coin', lane: i < 4 ? 1 : 2, x: 290 + i * 95, radius: game.COLLECTIBLE_TYPES.coin.radius, collected: false }));
      world.powerups = [{ id: 301, type: 'shield', lane: 0, x: 700, radius: 13, collected: false }];
      const samples = [], sprite = src => images.get(src) || null;
      for (let frame = 0; frame < 25; frame++) {
        const start = performance.now(); game.drawRunFrame(ctx, world, width, height, sprite);
        ctx.getImageData(0, 0, 1, 1); // flush deferred native raster
        samples.push(performance.now() - start); world.traveledPx += 5;
      }
      samples.sort((a, b) => a - b);
      const row = { mode, scene, width, height, median: samples[12], p95: samples[23] };
      rows.push(row); console.log(row);
    }
  }
  if (process.argv[2]) await writeFile(path.resolve(process.argv[2]), JSON.stringify(rows, null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }
