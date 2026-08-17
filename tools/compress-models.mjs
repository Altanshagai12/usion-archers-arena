/**
 * Turn the raw generated meshes in assets_raw/ into shippable ones in
 * public/models/.
 *
 * The generator hands back ~400 KB per prop carrying a 2048×2048 base-colour
 * texture. On disk that looks harmless; on a GPU it is ~22 MB of VRAM *each*,
 * and twelve of them would blow up exactly the low-end phones this game has to
 * run on. So the texture pass is the important one:
 *
 *   1. Resize every texture to 512 px and re-encode it (jimp — pure JS, because
 *      the sharp/libvips path in gltf-transform's own `textureCompress` fails
 *      on Windows with a colourspace error).
 *   2. Hand the result to gltf-transform for the geometry work: dedup, weld,
 *      prune and meshopt compression. Meshopt (not Draco) because three's
 *      MeshoptDecoder is bundled as a module — no extra wasm fetch at runtime.
 *
 *   npm run assets:compress
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeIO } from '@gltf-transform/core';
import Jimp from 'jimp';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const sourceDir = join(repoRoot, 'assets_raw');
const outDir = join(repoRoot, 'public', 'models');
const tmpDir = join(repoRoot, 'node_modules', '.cache', 'archers-assets');

/** Plenty for props that are never more than a few hundred pixels on screen. */
const TEXTURE_SIZE = 512;
const JPEG_QUALITY = 82;

// Run the CLI's JS entry with the current node binary. Spawning the generated
// .cmd/.ps1 shims fails on Windows, and this works identically everywhere.
const cli = join(repoRoot, 'node_modules', '@gltf-transform', 'cli', 'bin', 'cli.js');

mkdirSync(outDir, { recursive: true });
mkdirSync(tmpDir, { recursive: true });

const io = new NodeIO();

/** Skinned meshes must skip join/flatten — those rewrite node hierarchies. */
async function isSkinned(path) {
  const document = await io.read(path);
  return document.getRoot().listSkins().length > 0;
}

async function shrinkTextures(inputPath, outputPath) {
  const document = await io.read(inputPath);
  let resized = 0;

  for (const texture of document.getRoot().listTextures()) {
    const image = texture.getImage();
    if (!image) continue;

    const jimpImage = await Jimp.read(Buffer.from(image));
    const width = jimpImage.getWidth();
    const height = jimpImage.getHeight();
    const longest = Math.max(width, height);
    if (longest <= TEXTURE_SIZE) continue;

    const scale = TEXTURE_SIZE / longest;
    jimpImage.resize(Math.round(width * scale), Math.round(height * scale), Jimp.RESIZE_BILINEAR);
    jimpImage.quality(JPEG_QUALITY);

    const encoded = await jimpImage.getBufferAsync(Jimp.MIME_JPEG);
    texture.setImage(new Uint8Array(encoded)).setMimeType('image/jpeg');
    resized += 1;
  }

  await io.write(outputPath, document);
  return resized;
}

const files = readdirSync(sourceDir).filter((name) => name.endsWith('.glb'));
if (files.length === 0) {
  console.error(`No .glb files in ${sourceDir}`);
  process.exit(1);
}

let totalBefore = 0;
let totalAfter = 0;
const kb = (n) => `${Math.round(n / 1024)} KB`;

for (const name of files) {
  const input = join(sourceDir, name);
  const staged = join(tmpDir, name);
  const output = join(outDir, name);
  const before = statSync(input).size;

  const resized = await shrinkTextures(input, staged);
  const skinned = await isSkinned(staged);

  // A rigged character gets geometry compression only. `optimize` also runs
  // join/flatten, which rewrite the node hierarchy the skeleton is bound to
  // and would leave the archer a twisted mess.
  const args = skinned
    ? [cli, 'meshopt', staged, output]
    : [
        cli,
        'optimize',
        staged,
        output,
        '--compress',
        'meshopt',
        '--texture-compress',
        'false',
        '--simplify',
        'false',
      ];

  execFileSync(process.execPath, args, { stdio: ['ignore', 'ignore', 'inherit'] });

  const after = statSync(output).size;
  totalBefore += before;
  totalAfter += after;
  console.log(
    `${name.padEnd(20)} ${kb(before).padStart(8)} → ${kb(after).padStart(8)}  (${resized} texture${resized === 1 ? '' : 's'} resized)`,
  );
}

rmSync(tmpDir, { recursive: true, force: true });

const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
console.log(`\n${files.length} models: ${mb(totalBefore)} → ${mb(totalAfter)}`);
