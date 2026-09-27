// Offline renderer proofs; deliberately not an app route or authentication bypass.
// npm install --prefix /tmp/mpgr-visual esbuild @napi-rs/canvas
// MPGR_VISUAL_TOOLS=/tmp/mpgr-visual node scripts/mpgr-run-visual-proof.mjs /path/to/output
import { createRequire } from 'node:module';
import { mkdir, writeFile, readdir, mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const out = path.resolve(process.argv[2] || '.cache/mpgr-run-proofs');
const requireTool = createRequire(path.join(process.env.MPGR_VISUAL_TOOLS || root, 'package.json'));
const { build } = requireTool('esbuild');
const { createCanvas, loadImage } = requireTool('@napi-rs/canvas');
const temporary = await mkdtemp(path.join(tmpdir(), 'mpgr-proof-'));
await mkdir(out, { recursive: true });
try {
  const bundle = path.join(temporary, 'renderer.mjs');
  await build({
    stdin: { contents: [
      'export * from "./lib/games/mpgr-run/run-render";',
      'export * from "./lib/games/mpgr-run/run-assets";',
      'export * from "./lib/games/mpgr-run/run-world";',
      'export * from "./lib/games/mpgr-run/run-config";',
    ].join('\n'), resolveDir: root, loader: 'ts' },
    outfile: bundle, bundle: true, platform: 'node', format: 'esm', tsconfig: path.join(root, 'tsconfig.json'),
  });
  const game = await import(pathToFileURL(bundle).href);
  // Enables the exact browser mipmap path in the native Canvas harness.
  globalThis.document = { createElement: () => createCanvas(1, 1) };
  const images = new Map(), requested = new Set();
  for (const src of game.ALL_SPRITE_PATHS) images.set(src, await loadImage(path.join(root, 'public', src.split('?')[0])));
  const sprite = (src) => { requested.add(src); return images.get(src) || null; };
  const viewports = [['mobile', 390, 844], ['desktop', 1280, 720]];
  const worlds = [['city', 120], ['ice', 620], ['desert', 1060]];
  function fixture(meters, pose, frame = 0) {
    const world = game.freshWorld();
    world.elapsedMs = pose === 'stride' ? game.RUN_STRIDE_MS * 8 + game.RUN_FRAME_START_MS[frame] + 10 : 6000;
    world.traveledPx = meters * game.PX_PER_METER;
    if (pose === 'jump' || pose === 'fall') { world.player.playerY = 75; world.player.velocityY = pose === 'jump' ? 120 : -120; }
    if (pose === 'slide') world.player.sliding = true;
    if (['lane', 'left', 'right'].includes(pose)) { world.player.lane = pose === 'left' ? 0 : 2; world.player.laneOffset = (world.player.lane - 1) * game.LANE_GAP_PX; }
    // Renderer fixtures, NOT claims about authoritative spawn density.
    world.obstacles = [
      { id: 101, ...game.OBSTACLE_TYPES.crate, type: 'crate', lane: 0, x: 390, hit: false, passed: false },
      { id: 102, ...game.OBSTACLE_TYPES.barrier, type: 'barrier', lane: 2, x: 640, hit: false, passed: false },
    ];
    world.collectibles = Array.from({ length: 7 }, (_, i) => ({ id: 201 + i, type: 'coin', lane: i < 4 ? 1 : 2, x: 290 + i * 95, radius: game.COLLECTIBLE_TYPES.coin.radius, collected: false }));
    if (pose === 'airborne') world.collectibles[0].airHeight = 64;
    if (pose === 'obstacle') world.obstacles[0].x = 270;
    return world;
  }
  for (const [name, meters] of worlds) for (const [format, w, h] of viewports) {
    for (const pose of ['run', 'jump', 'fall', 'landing', 'left', 'center', 'right', 'slide', 'lane', 'airborne', 'obstacle']) {
      const canvas = createCanvas(w, h);
      game.drawRunFrame(canvas.getContext('2d'), fixture(meters, pose), w, h, sprite);
      await writeFile(path.join(out, `${name}-${format}-${pose}.png`), canvas.toBuffer('image/png'));
    }
  }
  const sheet = createCanvas(1440, 1040), ctx = sheet.getContext('2d');
  ctx.fillStyle = '#111b28'; ctx.fillRect(0, 0, 1440, 1040);
  for (let i = 0; i < worlds.length; i++) {
    const name = worlds[i][0];
    ctx.drawImage(await loadImage(path.join(out, `${name}-mobile-run.png`)), i * 480, 35, 300, 650);
    ctx.drawImage(await loadImage(path.join(out, `${name}-desktop-run.png`)), i * 480, 715, 470, 264);
    ctx.fillStyle = 'white'; ctx.font = '18px sans-serif';
    ctx.fillText(`${name.toUpperCase()} — mobile / desktop`, i * 480 + 10, 25);
  }
  await writeFile(path.join(out, 'worlds.jpg'), sheet.toBuffer('image/jpeg'));
  const actionSheet = createCanvas(1200, 950), ac = actionSheet.getContext('2d');
  ac.fillStyle = '#111b28'; ac.fillRect(0, 0, 1200, 950);
  for (const [i, pose] of ['run', 'jump', 'slide', 'lane'].entries()) {
    ac.drawImage(await loadImage(path.join(out, `city-mobile-${pose}.png`)), i * 300, 30, 300, 650);
    ac.fillStyle = 'white'; ac.font = '16px sans-serif'; ac.fillText(pose, i * 300 + 12, 22);
    const canvas = createCanvas(390, 844);
    game.drawRunFrame(canvas.getContext('2d'), fixture(120, 'stride', i), 390, 844, sprite);
    ac.drawImage(canvas, 110, 550, 180, 190, i * 300 + 30, 695, 230, 243);
  }
  await writeFile(path.join(out, 'actions.jpg'), actionSheet.toBuffer('image/jpeg'));
  const poses = ['run', 'jump', 'landing', 'left', 'center', 'right', 'slide', 'airborne', 'obstacle'];
  const states = createCanvas(780, 1780), st = states.getContext('2d');
  st.fillStyle = '#111b28'; st.fillRect(0, 0, states.width, states.height);
  for (const [i, pose] of poses.entries()) {
    const x = i % 3 * 260, y = Math.floor(i / 3) * 590;
    st.drawImage(await loadImage(path.join(out, `city-mobile-${pose}.png`)), x, y + 26, 260, 563);
    st.fillStyle = 'white'; st.font = '16px sans-serif'; st.fillText(pose, x + 8, y + 20);
  }
  await writeFile(path.join(out, 'states.jpg'), states.toBuffer('image/jpeg'));
  const preloaded = game.ALL_SPRITE_PATHS.map(src => src.split('?')[0]);
  const allDisk = await readdir(path.join(root, 'public/games/mpgr-run'), { recursive: true });
  const audit = {
    preloadedCount: preloaded.length,
    preloadedBytes: (await Promise.all(preloaded.map(async p => (await stat(path.join(root, 'public', p))).size))).reduce((a, b) => a + b, 0),
    requestedByProof: [...requested].sort(),
    notInCanvasPreload: allDisk.filter(p => p.endsWith('.webp') && !preloaded.includes('/games/mpgr-run/' + p)),
    note: 'notInCanvasPreload does not imply unused: DOM overlays, registry art and retained originals are included. Fixtures are renderer proofs, not authenticated live gameplay.',
  };
  await writeFile(path.join(out, 'asset-audit.json'), JSON.stringify(audit, null, 2));
  if (process.argv.includes('--benchmark')) {
    const timing = [];
    for (const [format, w, h] of viewports) {
      const canvas = createCanvas(w, h), context = canvas.getContext('2d'), world = game.freshWorld();
      world.traveledPx = 1000; world.elapsedMs = 6000;
      const samples = [];
      for (let i = 0; i < 25; i++) {
        const start = performance.now();
        game.drawRunFrame(context, world, w, h, sprite);
        context.getImageData(0, 0, 1, 1); // force the native deferred raster work
        samples.push(performance.now() - start); world.traveledPx += 5;
      }
      samples.sort((a, b) => a - b);
      timing.push({format, width:w, height:h, medianMs:samples[12], maxMs:samples[24]});
    }
    await writeFile(path.join(out, 'software-canvas-timing.json'), JSON.stringify({
      warning:'Software raster comparison only, NOT browser/device FPS. A regression here requires investigation, not a mobile performance claim.',
      timing,
    }, null, 2));
    console.log(timing);
  }
  console.log(`Proofs and asset audit written to ${out}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
