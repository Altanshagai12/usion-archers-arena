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

/**
 * Is the tail of an elongated model at the far end of its long axis?
 *
 * An arrow is the only asymmetric model here, and its asymmetry is reliable:
 * the fletched end is far fatter than the point. Measuring which end that is
 * beats assuming the model was authored pointing any particular way — this one
 * was modelled pointing backwards, so the nocked arrow sat on the bow facing
 * the archer and every shot flew tail-first.
 *
 * Exported so the rule is tested — it is a heuristic, and a silent wrong
 * answer turns every arrow in the game around.
 */
export function tailAtMax(root: THREE.Object3D, axis: 0 | 1 | 2): boolean {
  const points: Array<[number, number, number]> = [];
  const vertex = new THREE.Vector3();
  root.updateWorldMatrix(true, true);
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    const position = mesh.isMesh ? mesh.geometry?.getAttribute('position') : null;
    if (!position) return;
    for (let i = 0; i < position.count; i += 1) {
      vertex.fromBufferAttribute(position as THREE.BufferAttribute, i);
      vertex.applyMatrix4(mesh.matrixWorld);
      points.push([vertex.x, vertex.y, vertex.z]);
    }
  });
  if (points.length < 8) return false;

  let low = Infinity;
  let high = -Infinity;
  const others = [0, 1, 2].filter((i) => i !== axis) as [number, number];
  const centre = [0, 0];
  for (const point of points) {
    if (point[axis] < low) low = point[axis];
    if (point[axis] > high) high = point[axis];
    centre[0] += point[others[0]];
    centre[1] += point[others[1]];
  }
  centre[0] /= points.length;
  centre[1] /= points.length;

  const span = high - low;
  if (span < 1e-6) return false;

  // Mean distance from the shaft's own centre line, over the outermost sixth
  // at each end. Fletching flares; a point tapers.
  const girth = (from: number, to: number): number => {
    let sum = 0;
    let count = 0;
    for (const point of points) {
      const along = (point[axis] - low) / span;
      if (along < from || along > to) continue;
      sum += Math.hypot(point[others[0]] - centre[0], point[others[1]] - centre[1]);
      count += 1;
    }
    return count ? sum / count : 0;
  };

  return girth(0.84, 1) > girth(0, 0.16);
}

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
    } else if (tailAtMax(root, longest.x ? 0 : longest.y ? 1 : 2)) {
      // Aligning the long axis leaves the model pointing either way down it.
      // Turn it round so the POINT leads.
      axisFix.premultiply(
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI),
      );
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
