/**
 * Turn the Mixamo FBX exports into the GLBs the game ships.
 *
 * Each FBX was exported "with skin", so all three carry the same 65-bone
 * Mixamo skeleton and a copy of the character. That means no retargeting: one
 * file supplies the character, and the others are reduced to their skeleton and
 * clip so those clips can be played on it — three binds clips by node name and
 * the names match exactly.
 *
 * The exports carry no materials or textures at all, so the character arrives
 * untextured and the game colours it per seat. That trade is deliberate: real
 * archery motion matters more here than a painted figure, and nothing else
 * available ships a draw.
 *
 *   npm run assets:mixamo        (source FBX files are not committed)
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

// GLTFExporter reaches for FileReader to turn its Blob into an ArrayBuffer.
// Node has Blob but not FileReader, so stand one in.
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((buffer) => {
        this.result = buffer;
        this.onloadend?.();
      });
    }
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(resolve(here, '..'), 'assets_raw');
const SOURCE_DIR = process.env.MIXAMO_DIR ?? 'C:/Users/altan/Downloads';

/** The first entry supplies the character; the rest are clip-only. */
const SOURCES = [
  { file: 'Standing Draw Arrow.fbx', clip: 'Draw', keepMesh: true, out: 'archer_mx.glb' },
  { file: 'Standing Aim Overdraw.fbx', clip: 'Aim', keepMesh: false, out: 'anim_aim.glb' },
  { file: 'Standing Death Right 02.fbx', clip: 'Death', keepMesh: false, out: 'anim_death.glb' },
];

mkdirSync(outDir, { recursive: true });

const loader = new FBXLoader();
const exporter = new GLTFExporter();

function exportGlb(scene, animations) {
  return new Promise((resolve, reject) => {
    exporter.parse(
      scene,
      (result) => resolve(Buffer.from(result)),
      (error) => reject(error),
      { binary: true, animations, includeCustomExtensions: false },
    );
  });
}

for (const source of SOURCES) {
  const path = join(SOURCE_DIR, source.file);
  const buffer = readFileSync(path);
  const group = loader.parse(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    '',
  );

  // Mixamo names every take "mixamo.com"; give the clip a name to ask for.
  const clip = group.animations[0];
  if (!clip) throw new Error(`no animation in ${source.file}`);
  clip.name = source.clip;

  if (!source.keepMesh) {
    // Drop the character but keep the bones, so the clip still has something
    // to drive and the file loses nearly all of its weight.
    const doomed = [];
    group.traverse((child) => {
      if (child.isSkinnedMesh || child.isMesh) doomed.push(child);
    });
    for (const mesh of doomed) mesh.removeFromParent();
  } else {
    // The exports have no materials; give every surface something plain that
    // the game can tint per seat.
    group.traverse((child) => {
      if (!child.isMesh) return;
      child.material = new THREE.MeshStandardMaterial({
        color: 0xb9bec7,
        roughness: 0.82,
        metalness: 0.02,
      });
      child.castShadow = true;
      child.receiveShadow = true;
    });
  }

  const glb = await exportGlb(group, [clip]);
  const target = join(outDir, source.out);
  writeFileSync(target, glb);
  console.log(
    `${source.file.padEnd(30)} -> ${source.out.padEnd(16)} ${Math.round(statSync(target).size / 1024)} KB`,
  );
}
