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
  | 'archer_mx'
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
const LONG_AXIS_ALIGN: Partial<Record<ModelKey, 'y' | 'z'>> = {
  // The arrow points where it flies.
  arrow: 'z',
  // The bow stands upright in the hand; its model lies on its side.
  bow: 'y',
};

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
  archer_mx: 1.78,
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
/** Authored clips that shipped with a model, kept beside its template. */
const clips = new Map<ModelKey, THREE.AnimationClip[]>();
const pending = new Map<ModelKey, Promise<THREE.Group>>();

function normalise(
  root: THREE.Object3D,
  targetHeight: number,
  align: 'y' | 'z' | null,
  centred: boolean,
): THREE.Group {
  const fitLongest = align !== null;
  const wrapper = new THREE.Group();

  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  const centre = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(centre);

  const reference = fitLongest ? Math.max(size.x, size.y, size.z) : size.y;
  const scale = targetHeight / (reference || 1);

  // Elongated models arrive lying along whatever axis they were modelled on.
  // Turning them into a known pose lets callers treat "the arrow points +z" and
  // "the bow stands upright, limbs curving down-range" as facts rather than
  // per-model guesses: the longest axis goes to the requested one, and for an
  // upright model the second-longest then goes down-range (+z) — a bow's limbs
  // curve away from the archer, not out to the side.
  let axisFix: THREE.Quaternion | null = null;
  if (align) {
    const longest =
      size.x >= size.y && size.x >= size.z
        ? new THREE.Vector3(1, 0, 0)
        : size.y >= size.z
          ? new THREE.Vector3(0, 1, 0)
          : new THREE.Vector3(0, 0, 1);
    const target = align === 'y' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    axisFix = new THREE.Quaternion().setFromUnitVectors(longest, target);

    if (align === 'y') {
      const turned = size.clone().applyQuaternion(axisFix);
      if (Math.abs(turned.x) > Math.abs(turned.z)) {
        axisFix.premultiply(
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2),
        );
      }
    }
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
    oriented.quaternion.copy(axisFix);
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
        LONG_AXIS_ALIGN[key] ?? null,
        HELD_IN_HAND.has(key),
      );
      cache.set(key, normalised);
      clips.set(key, gltf.animations ?? []);
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
 * Animation clips that shipped with a model. Empty until it has loaded, and
 * empty forever for models that carry none.
 */
export function animationsFor(key: ModelKey): THREE.AnimationClip[] {
  return clips.get(key) ?? [];
}

const clipFiles = new Map<string, Promise<THREE.AnimationClip[]>>();

/**
 * Load a clip-only .glb — a skeleton and one animation, no character.
 *
 * The Mixamo exports all share one skeleton, so a clip taken from one file
 * plays on the character from another: three binds clips by node name. Keeping
 * the extra clips in their own files ships the character mesh once instead of
 * three times.
 *
 * Never rejects: a missing clip costs an animation, not the match.
 */
export async function loadClips(name: string): Promise<THREE.AnimationClip[]> {
  const existing = clipFiles.get(name);
  if (existing) return existing;

  const promise = loader
    .loadAsync(`${BASE_URL}${name}.glb`)
    .then((gltf) => gltf.animations ?? [])
    .catch((error) => {
      console.warn(`[archers-arena] clips "${name}" unavailable`, error);
      return [] as THREE.AnimationClip[];
    });

  clipFiles.set(name, promise);
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
