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
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';

import { fallbackModel } from './fallback';

export type ModelKey =
  | 'archer_rigged'
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
  | 'crate'
  | 'fence'
  | 'target';

/**
 * Drawn with plain geometry rather than shipped as a .glb. Repeated rail
 * sections and round straw targets are crisper built than generated, and at
 * this size nobody can tell — so we skip the download entirely.
 */
const PROCEDURAL_ONLY: ReadonlySet<ModelKey> = new Set<ModelKey>(['fence', 'target']);

/**
 * Which axis a model's target size refers to.
 *
 * Default is height, which is right for anything that stands up. An arrow is
 * generated lying flat, so its bounding box is barely tall at all — scaling
 * that to 0.78 m of *height* blew it up to the size of a tree. Elongated props
 * are fitted on their longest axis instead.
 */
const FIT_LONGEST_AXIS: ReadonlySet<ModelKey> = new Set<ModelKey>(['arrow']);

/**
 * Models held in a hand rather than stood on the ground.
 *
 * These are centred on their own middle so they pivot correctly and so a bow
 * and the arrow nocked on it share an origin. Aligning the bow by its base
 * instead put the arrow down at the lower limb tip, floating clear of the bow.
 */
const HELD_IN_HAND: ReadonlySet<ModelKey> = new Set<ModelKey>(['bow', 'arrow']);

/** Target size in metres for each model, applied after normalisation. */
const TARGET_HEIGHT: Record<ModelKey, number> = {
  archer_rigged: 1.78,
  archer_a: 1.78,
  archer_b: 1.78,
  bow: 1.08,
  arrow: 0.78,
  quiver: 0.56,
  tree: 6.4,
  rock: 1.5,
  castle_wall: 7.5,
  castle_tower: 12,
  ruin_column: 4.2,
  banner: 3.6,
  crate: 0.95,
  fence: 1.3,
  target: 1.5,
};

const BASE_URL = `${import.meta.env.BASE_URL}models/`;

// The shipped models are meshopt-compressed (see tools/compress-models.mjs).
// The decoder is bundled with three, so this costs no extra network request.
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const cache = new Map<ModelKey, THREE.Group>();
const pending = new Map<ModelKey, Promise<THREE.Group>>();

function normalise(
  root: THREE.Object3D,
  targetHeight: number,
  fitLongest: boolean,
  centred: boolean,
): THREE.Group {
  const wrapper = new THREE.Group();

  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  const centre = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(centre);

  const reference = fitLongest ? Math.max(size.x, size.y, size.z) : size.y;
  const scale = targetHeight / (reference || 1);

  // Elongated models are generated lying along an arbitrary axis. Turn the long
  // axis to +z so callers can treat "the arrow points +z" as a fact instead of
  // guessing per model — guessing is what left the nocked arrow pointing
  // sideways across the archer's chest.
  let axisFix: THREE.Euler | null = null;
  if (fitLongest) {
    if (size.x >= size.y && size.x >= size.z) axisFix = new THREE.Euler(0, -Math.PI / 2, 0);
    else if (size.y >= size.x && size.y >= size.z) axisFix = new THREE.Euler(Math.PI / 2, 0, 0);
  }

  // Standing props are centred on their footprint and dropped onto y = 0.
  // Held items are centred on all three axes instead, so they pivot about
  // their middle — and so a bow and its nocked arrow share an origin.
  if (centred) root.position.set(-centre.x, -centre.y, -centre.z);
  else root.position.set(-centre.x, -box.min.y, -centre.z);

  const scaler = new THREE.Group();
  scaler.scale.setScalar(scale);
  scaler.add(root);

  if (axisFix) {
    const oriented = new THREE.Group();
    oriented.rotation.copy(axisFix);
    oriented.add(scaler);
    wrapper.add(oriented);
  } else {
    wrapper.add(scaler);
  }

  wrapper.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // A posed skeleton moves vertices outside the bind-pose bounds, so leave
    // culling to the renderer's own bounds rather than a stale bounding box.
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) mesh.frustumCulled = false;

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

function hasSkeleton(root: THREE.Object3D): boolean {
  let found = false;
  root.traverse((child) => {
    if ((child as THREE.SkinnedMesh).isSkinnedMesh) found = true;
  });
  return found;
}

export async function loadModel(key: ModelKey): Promise<THREE.Group> {
  const cached = cache.get(key);
  if (cached) return cached;

  const inFlight = pending.get(key);
  if (inFlight) return inFlight;

  const promise = loader
    .loadAsync(`${BASE_URL}${key}.glb`)
    .then((gltf) => {
      const normalised = normalise(
        gltf.scene,
        TARGET_HEIGHT[key],
        FIT_LONGEST_AXIS.has(key),
        HELD_IN_HAND.has(key),
      );
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

/**
 * A fresh, independently transformable copy. Geometry/materials stay shared.
 *
 * This NEVER rejects. A missing or corrupt .glb yields a procedural stand-in
 * instead, because a match that cannot start is far worse than one that looks
 * plainer than intended — and an unhandled rejection here used to abort arena
 * construction silently, leaving the game frozen on "waiting".
 */
export async function instantiate(key: ModelKey): Promise<THREE.Group> {
  if (PROCEDURAL_ONLY.has(key)) return fallbackModel(key);
  try {
    const template = await loadModel(key);
    // Object3D.clone shares the Skeleton, so two archers would share one pose.
    // SkeletonUtils rebuilds the bone hierarchy per copy.
    if (hasSkeleton(template)) return skeletonClone(template) as THREE.Group;
    return template.clone(true);
  } catch (error) {
    console.warn(`[archers-arena] model "${key}" unavailable, using fallback`, error);
    return fallbackModel(key);
  }
}

/**
 * Warm the cache for a set of models. Failures resolve rather than reject —
 * a missing prop must never stop a match from starting, and `instantiate`
 * surfaces the real error at use time.
 */
export async function preload(keys: ModelKey[]): Promise<void> {
  await Promise.all(
    keys
      .filter((key) => !PROCEDURAL_ONLY.has(key))
      .map((key) =>
      loadModel(key).catch((error) => {
        console.warn(`[archers-arena] model "${key}" failed to load`, error);
        return null;
      }),
    ),
  );
}
