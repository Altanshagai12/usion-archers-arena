/**
 * GLB loading and normalisation.
 *
 * The meshes are AI-generated, so they arrive at arbitrary scale, arbitrary
 * orientation and with their origin anywhere. Nothing downstream should have to
 * care: `loadModel` re-centres each mesh on its own footprint, drops it so its
 * lowest point sits at y = 0, and scales it to an explicit target height in
 * metres. After that a tree is a tree-sized tree wherever it came from.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

export type ModelKey =
  | 'archer_a'
  | 'archer_b'
  | 'bow'
  | 'arrow'
  | 'quiver'
  | 'tree'
  | 'rock'
  | 'castle_wall'
  | 'castle_tower'
  | 'ruin_column'
  | 'banner'
  | 'crate';

/** Target height in metres for each model, applied after normalisation. */
const TARGET_HEIGHT: Record<ModelKey, number> = {
  archer_a: 1.78,
  archer_b: 1.78,
  bow: 1.15,
  arrow: 0.78,
  quiver: 0.56,
  tree: 6.4,
  rock: 1.5,
  castle_wall: 7.5,
  castle_tower: 12,
  ruin_column: 4.2,
  banner: 3.6,
  crate: 0.95,
};

const BASE_URL = `${import.meta.env.BASE_URL}models/`;

// The shipped models are meshopt-compressed (see tools/compress-models.mjs).
// The decoder is bundled with three, so this costs no extra network request.
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const cache = new Map<ModelKey, THREE.Group>();
const pending = new Map<ModelKey, Promise<THREE.Group>>();

function normalise(root: THREE.Object3D, targetHeight: number): THREE.Group {
  const wrapper = new THREE.Group();

  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  const centre = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(centre);

  const height = size.y || 1;
  const scale = targetHeight / height;

  // Centre horizontally on the footprint, and put the lowest point on y = 0.
  root.position.set(-centre.x, -box.min.y, -centre.z);

  const scaler = new THREE.Group();
  scaler.scale.setScalar(scale);
  scaler.add(root);
  wrapper.add(scaler);

  wrapper.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const material = mesh.material as THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[];
    const materials = Array.isArray(material) ? material : [material];
    for (const m of materials) {
      if (!m) continue;
      // Generated materials are frequently double-sided and shiny; both cost
      // fill rate on phones and neither suits the flat art direction.
      m.side = THREE.FrontSide;
      if ('roughness' in m) m.roughness = Math.max(0.62, m.roughness ?? 1);
      if ('metalness' in m) m.metalness = Math.min(0.08, m.metalness ?? 0);
      if (m.map) m.map.anisotropy = 4;
    }
  });

  return wrapper;
}

export async function loadModel(key: ModelKey): Promise<THREE.Group> {
  const cached = cache.get(key);
  if (cached) return cached;

  const inFlight = pending.get(key);
  if (inFlight) return inFlight;

  const promise = loader
    .loadAsync(`${BASE_URL}${key}.glb`)
    .then((gltf) => {
      const normalised = normalise(gltf.scene, TARGET_HEIGHT[key]);
      cache.set(key, normalised);
      pending.delete(key);
      return normalised;
    })
    .catch((error) => {
      pending.delete(key);
      throw error;
    });

  pending.set(key, promise);
  return promise;
}

/** A fresh, independently transformable copy. Geometry/materials stay shared. */
export async function instantiate(key: ModelKey): Promise<THREE.Group> {
  const template = await loadModel(key);
  return template.clone(true);
}

/**
 * Warm the cache for a set of models. Failures resolve rather than reject —
 * a missing prop must never stop a match from starting, and `instantiate`
 * surfaces the real error at use time.
 */
export async function preload(keys: ModelKey[]): Promise<void> {
  await Promise.all(
    keys.map((key) =>
      loadModel(key).catch((error) => {
        console.warn(`[archers-arena] model "${key}" failed to load`, error);
        return null;
      }),
    ),
  );
}
