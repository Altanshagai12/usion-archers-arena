/**
 * Turn the Mixamo FBX exports into the GLBs the game ships.
 *
 * Each FBX was exported "with skin", so all three carry the same 65-bone
 * Mixamo skeleton and a copy of the character. That means no retargeting: one
 * file supplies the character, and the others are reduced to their skeleton and
 * clip so those clips can be played on it — three binds clips by node name and
 * the names match exactly.
 *
 * Mixamo's mannequins (Beta, X Bot, Y Bot) carry flat materials and no
 * textures; a real character from the Characters tab embeds its maps. Both are
 * handled: embedded textures are extracted and attached to the glTF, and a
 * character that has none gets a plain surface for the game to dress by
 * painting its vertices (src/render/outfit.ts).
 *
 * Getting the textures out in Node needs some care. three's FBXLoader hands
 * embedded images to a browser — `window.URL.createObjectURL` for the bytes,
 * then a TextureLoader that wants an <img> — and GLTFExporter then wants a
 * canvas to re-encode them. None of that exists here, and none of it is
 * needed: the bytes are already in the file. So the loader is given somewhere
 * DOM-free to put them, the mesh is exported with no maps at all, and the
 * images are attached afterwards with gltf-transform, which speaks bytes.
 *
 *   npm run assets:mixamo        (source FBX files are not committed)
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeIO } from '@gltf-transform/core';
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

// FBXLoader wraps each embedded image in a Blob and asks the browser for an
// object URL. Node's own Blob only gives its bytes back asynchronously, which
// is no use inside a synchronous parse — so both are stood in with a pair that
// hands back a data: URL carrying the bytes.
class InlineBlob {
  constructor(parts, options = {}) {
    this.parts = parts;
    this.type = options.type ?? 'application/octet-stream';
  }

  /** GLTFExporter builds a real Blob for its own output and then reads it. */
  bytes() {
    return Buffer.concat(
      this.parts.map((part) => Buffer.from(part.buffer ?? part, part.byteOffset ?? 0, part.byteLength ?? undefined)),
    );
  }

  arrayBuffer() {
    const buffer = this.bytes();
    return Promise.resolve(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    );
  }
}

globalThis.Blob = InlineBlob;
globalThis.window = {
  URL: {
    createObjectURL(blob) {
      return `data:${blob.type};base64,${blob.bytes().toString('base64')}`;
    },
  },
};

/**
 * A texture loader that touches no DOM: it keeps the image URL on the texture
 * and leaves decoding to whoever needs pixels. Nothing here does — the bytes
 * go straight into the glTF.
 */
class HeadlessTextureLoader {
  constructor() {
    this.path = '';
  }

  setPath(path) {
    this.path = path ?? '';
    return this;
  }

  load(url) {
    const texture = new THREE.Texture();
    texture.userData.source = url;
    return texture;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(resolve(here, '..'), 'assets_raw');
const SOURCE_DIR = process.env.MIXAMO_DIR ?? 'C:/Users/altan/Downloads';

/** The first entry supplies the character; the rest are clip-only. */
const SOURCES = [
  { file: 'Standing Draw Arrow', clip: 'Draw', keepMesh: true, out: 'archer_mx.glb' },
  { file: 'Standing Aim Overdraw', clip: 'Aim', keepMesh: false, out: 'anim_aim.glb' },
  { file: 'Standing Death Right 02', clip: 'Death', keepMesh: false, out: 'anim_death.glb' },
];

/**
 * The newest download whose name starts with this one.
 *
 * A browser names a second download of the same animation "… (1).fbx", so
 * matching the exact name would silently keep converting the previous
 * character after a re-download.
 */
function newestSource(base) {
  const candidates = readdirSync(SOURCE_DIR)
    .filter((name) => name.startsWith(base) && name.toLowerCase().endsWith('.fbx'))
    .map((name) => ({ name, at: statSync(join(SOURCE_DIR, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  if (!candidates.length) throw new Error(`no "${base}*.fbx" in ${SOURCE_DIR}`);
  return candidates[0].name;
}

function bytesOfDataUrl(url) {
  const comma = url.indexOf(',');
  const header = url.slice(5, comma);
  const [mime] = header.split(';');
  return { mime, bytes: new Uint8Array(Buffer.from(url.slice(comma + 1), 'base64')) };
}

/**
 * Put every skinned mesh on ONE skeleton.
 *
 * FBXLoader gives each skinned mesh its own copy of the bone hierarchy, and an
 * animation can only drive one of them: five of Erika Archer's six meshes —
 * her bow and her arrow among them — sat frozen in their bind pose while the
 * body moved, so she drew nothing and held nothing.
 *
 * The copies are identical bone-for-bone, so every mesh is rebound, by name,
 * to the ONE hierarchy that is actually in the scene graph. That last part is
 * the whole trick: an animation track names its target, and both three and the
 * glTF exporter resolve that name against the scene. Rebinding the meshes onto
 * some other identical-looking copy — the first mesh's own, say — leaves the
 * meshes on bones the clip has no way to reach, which looks exactly like the
 * bug it was meant to fix. Each mesh keeps its OWN bind inverses, which are
 * what tie its vertices to the pose it was skinned in.
 */
function unifySkeleton(group) {
  const meshes = [];
  const inScene = new Map();
  group.traverse((child) => {
    if (child.isSkinnedMesh) meshes.push(child);
    // First one wins, matching how a track name is resolved.
    if (child.isBone && !inScene.has(child.name)) inScene.set(child.name, child);
  });
  if (meshes.length < 2 || inScene.size === 0) return;

  let missing = 0;
  for (const mesh of meshes) {
    const bones = mesh.skeleton.bones.map((bone) => {
      const shared = inScene.get(bone.name);
      if (!shared) missing += 1;
      return shared ?? bone;
    });
    mesh.bind(new THREE.Skeleton(bones, mesh.skeleton.boneInverses), mesh.bindMatrix);
  }

  console.log(
    `  unified ${meshes.length} meshes onto the scene's ${inScene.size}-bone skeleton` +
      (missing ? ` — ${missing} bone(s) had no match` : ''),
  );
}

/**
 * Fail loudly if the clip cannot reach the bones the meshes are bound to.
 *
 * This is the exact failure that shipped: the character animated, so nothing
 * looked broken, while her bow and arrow hung motionless in bind pose.
 */
function assertClipDrivesMeshes(group, clip) {
  const meshes = [];
  group.traverse((child) => {
    if (child.isSkinnedMesh) meshes.push(child);
  });
  if (!meshes.length) return;

  const bound = new Set();
  for (const mesh of meshes) for (const bone of mesh.skeleton.bones) bound.add(bone);

  let driven = 0;
  for (const track of clip.tracks) {
    const node = THREE.PropertyBinding.findNode(group, track.name.split('.')[0]);
    if (node && bound.has(node)) driven += 1;
  }
  if (driven === 0) {
    throw new Error(`"${clip.name}" drives none of the bones the meshes use`);
  }
  console.log(`  ${driven}/${clip.tracks.length} clip tracks reach the skinned skeleton`);
}

mkdirSync(outDir, { recursive: true });

const manager = new THREE.LoadingManager();
manager.addHandler(/\.(png|jpe?g|webp|tga|bmp)$/i, new HeadlessTextureLoader());
const loader = new FBXLoader(manager);
const exporter = new GLTFExporter();
const io = new NodeIO();

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

/** Put the images back, keyed by the material name they came off. */
async function attachTextures(glb, maps) {
  if (maps.size === 0) return glb;

  const doc = await io.readBinary(glb);
  let attached = 0;
  for (const material of doc.getRoot().listMaterials()) {
    const found = maps.get(material.getName());
    if (!found) continue;

    const base = doc
      .createTexture(`${material.getName()}_base`)
      .setImage(found.base.bytes)
      .setMimeType(found.base.mime);
    material.setBaseColorTexture(base);
    // The factor multiplies the texture, so anything but white tints the art.
    material.setBaseColorFactor([1, 1, 1, 1]);

    if (found.normal) {
      const normal = doc
        .createTexture(`${material.getName()}_normal`)
        .setImage(found.normal.bytes)
        .setMimeType(found.normal.mime);
      material.setNormalTexture(normal);
    }
    attached += 1;
  }

  if (attached !== maps.size) {
    console.warn(`  ⚠ ${maps.size} texture set(s) found but ${attached} attached — names differ`);
  }
  return Buffer.from(await io.writeBinary(doc));
}

for (const source of SOURCES) {
  const file = newestSource(source.file);
  const buffer = readFileSync(join(SOURCE_DIR, file));
  const group = loader.parse(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    '',
  );

  // Mixamo names every take "mixamo.com"; give the clip a name to ask for.
  const clip = group.animations[0];
  if (!clip) throw new Error(`no animation in ${file}`);
  clip.name = source.clip;

  const maps = new Map();

  if (source.keepMesh) {
    unifySkeleton(group);
    assertClipDrivesMeshes(group, clip);
  }

  if (!source.keepMesh) {
    // Drop the character but keep the bones, so the clip still has something
    // to drive and the file loses nearly all of its weight.
    const doomed = [];
    group.traverse((child) => {
      if (child.isSkinnedMesh || child.isMesh) doomed.push(child);
    });
    for (const mesh of doomed) mesh.removeFromParent();
  } else {
    // FBXLoader builds Phong materials, which is not what a glTF wants. The
    // maps are set aside rather than carried, because exporting them needs a
    // canvas; they go back in afterwards.
    const parts = [];
    group.traverse((child) => {
      if (!child.isMesh) return;
      parts.push(`${child.name}(${child.geometry.getAttribute('position').count})`);
      const originals = Array.isArray(child.material) ? child.material : [child.material];
      const converted = originals.map((original, index) => {
        const name = original?.name || `material_${index}`;
        const source = original?.map?.userData?.source;
        if (source) {
          maps.set(name, {
            base: bytesOfDataUrl(source),
            normal: original.normalMap?.userData?.source
              ? bytesOfDataUrl(original.normalMap.userData.source)
              : null,
          });
        }
        return new THREE.MeshStandardMaterial({
          name,
          // White under a texture, plain grey when there is none to wear.
          color: source ? new THREE.Color(0xffffff) : new THREE.Color(0xb9bec7),
          roughness: 0.82,
          metalness: 0.02,
        });
      });
      child.material = Array.isArray(child.material) ? converted : converted[0];
      child.castShadow = true;
      child.receiveShadow = true;
    });

    console.log(`  meshes: ${parts.join(' ')}`);
    console.log(
      maps.size > 0
        ? `  ${maps.size} textured material(s) — the game will not paint over them`
        : '  no textures in this export (a Mixamo mannequin) — the game paints an outfit on',
    );
  }

  const glb = await attachTextures(await exportGlb(group, [clip]), maps);
  const target = join(outDir, source.out);
  writeFileSync(target, glb);
  console.log(
    `${file.padEnd(34)} -> ${source.out.padEnd(16)} ${Math.round(statSync(target).size / 1024)} KB`,
  );
}
