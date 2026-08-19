/**
 * Dress the archer.
 *
 * The Mixamo character ships as a bare grey mannequin — no textures, one flat
 * material — so until now both archers were a single solid colour. There is no
 * outfit mesh to put on it either: clothing modelled separately would have to
 * be skinned to the same skeleton to move with the body, and an unskinned
 * garment floats off the figure the moment it draws.
 *
 * But the character already carries everything needed to dress itself. Every
 * vertex names the bones that move it, and Mixamo's skeleton uses fixed names,
 * so the body part a vertex belongs to is a known fact: the bone that moves it
 * most IS the body part. Painting per-vertex from that gives boots, trousers,
 * a belt, a tunic, sleeves, bracers and bare hands that deform perfectly —
 * because they are the character's own vertices, skinned by its own skeleton.
 *
 * The tunic takes the team colour, so at a glance you can still tell which
 * archer is you while the rest of the outfit stays the same on both.
 */

import * as THREE from 'three';

export interface Outfit {
  /** The tunic and sleeves — the team colour. */
  tunic: number;
  skin: number;
  /** Bracers on the forearms. */
  leather: number;
  trousers: number;
  boots: number;
  belt: number;
}

type Region = keyof Outfit;

/** Everything but the tunic is the same on both archers. */
const BASE_OUTFIT: Omit<Outfit, 'tunic'> = {
  skin: 0xd8a978,
  leather: 0x8a5a34,
  trousers: 0x4a4f57,
  boots: 0x2f3238,
  belt: 0x5a3d22,
};

export function outfitFor(tunic: number): Outfit {
  return { tunic, ...BASE_OUTFIT };
}

/** Fraction of the pelvis, measured from its top, that the belt covers. */
const BELT_DEPTH = 0.28;

/**
 * Which garment a bone wears. Exported so the ordering below is tested.
 *
 * Order matters, because Mixamo's names nest: every finger bone is a `Hand`,
 * and a `ForeArm` is also an `Arm`. The narrower part is always tested first.
 */
export function regionOf(boneName: string): Region {
  const name = boneName
    .replace(/^mixamorig/i, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();

  if (name.includes('toe') || name.includes('foot')) return 'boots';
  if (name.includes('leg') || name.includes('hips')) return 'trousers';
  if (name.includes('hand')) return 'skin';
  if (name.includes('forearm')) return 'leather';
  if (name.includes('head') || name.includes('neck')) return 'skin';
  return 'tunic';
}

/**
 * Dressed geometry, keyed by source mesh and tunic colour.
 *
 * There are only ever two outfits on screen, and the arena is rebuilt for
 * every match, so caching turns a per-match pass over 147k vertices — and a
 * per-match buffer that would never be freed — into a one-off.
 */
const dressed = new Map<string, THREE.BufferGeometry>();

/**
 * Paint one skinned mesh.
 *
 * The heavy attributes are SHARED with the source rather than copied: at 147k
 * vertices, positions, normals and skin weights are megabytes that are
 * identical for both archers. Only the colours differ, and they are one byte
 * per channel because the palette is a handful of flat colours with no
 * gradients to band.
 */
function paint(mesh: THREE.SkinnedMesh, outfit: Outfit): boolean {
  const source = mesh.geometry;
  const position = source.getAttribute('position');
  const skinIndex = source.getAttribute('skinIndex');
  const skinWeight = source.getAttribute('skinWeight');
  const bones = mesh.skeleton?.bones;
  if (!position || !skinIndex || !skinWeight || !bones?.length) return false;

  const key = `${source.uuid}:${outfit.tunic}`;
  const cached = dressed.get(key);
  if (cached) {
    mesh.geometry = cached;
    return true;
  }

  const regions = bones.map((bone) => regionOf(bone.name));
  const count = position.count;

  // The bone that moves each vertex most is the body part it belongs to.
  const owner: Region[] = new Array(count);
  let pelvisLow = Infinity;
  let pelvisHigh = -Infinity;
  for (let i = 0; i < count; i += 1) {
    let best = 0;
    let bestWeight = -1;
    for (let slot = 0; slot < 4; slot += 1) {
      const weight = skinWeight.getComponent(i, slot);
      if (weight > bestWeight) {
        bestWeight = weight;
        best = skinIndex.getComponent(i, slot);
      }
    }
    owner[i] = regions[best] ?? 'tunic';
    // The belt is the top of the pelvis, so the pelvis has to be measured
    // before anything can be called a belt.
    if (/hips/i.test(bones[best]?.name ?? '')) {
      const y = position.getY(i);
      if (y < pelvisLow) pelvisLow = y;
      if (y > pelvisHigh) pelvisHigh = y;
    }
  }

  const beltFrom = pelvisHigh - (pelvisHigh - pelvisLow) * BELT_DEPTH;
  const colours = new Uint8Array(count * 3);
  const colour = new THREE.Color();
  // Cached per region: the palette is six colours over 147k vertices.
  const bytes = new Map<Region, [number, number, number]>();
  for (const region of Object.keys(outfit) as Region[]) {
    // setHex decodes from sRGB into the renderer's working space, which is
    // what a vertex-colour attribute is read as.
    colour.setHex(outfit[region]);
    bytes.set(region, [
      Math.round(colour.r * 255),
      Math.round(colour.g * 255),
      Math.round(colour.b * 255),
    ]);
  }

  for (let i = 0; i < count; i += 1) {
    let region = owner[i];
    if (region === 'trousers' && Number.isFinite(beltFrom) && position.getY(i) >= beltFrom) {
      region = 'belt';
    }
    const rgb = bytes.get(region) ?? bytes.get('tunic')!;
    colours[i * 3] = rgb[0];
    colours[i * 3 + 1] = rgb[1];
    colours[i * 3 + 2] = rgb[2];
  }

  const geometry = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(source.attributes)) {
    geometry.setAttribute(name, attribute as THREE.BufferAttribute);
  }
  if (source.index) geometry.setIndex(source.index);
  for (const group of source.groups) {
    geometry.addGroup(group.start, group.count, group.materialIndex);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3, true));
  geometry.boundingSphere = source.boundingSphere;
  geometry.boundingBox = source.boundingBox;

  dressed.set(key, geometry);
  mesh.geometry = geometry;
  return true;
}

/**
 * Dress a whole character.
 *
 * Materials are cloned per archer because two of them are on screen wearing
 * different tunics, and set to white so the vertex colours come through
 * unmodulated — the material colour multiplies them.
 */
export function dressCharacter(root: THREE.Object3D, outfit: Outfit): void {
  root.traverse((child) => {
    const mesh = child as THREE.SkinnedMesh;
    if (!mesh.isMesh) return;

    // Painted FIRST, because a mesh that could not be painted must never be
    // told to use vertex colours: the shader would read an attribute that is
    // not there and the whole figure would render black. Such a mesh falls
    // back to the flat team colour it wore before there were any clothes.
    const painted = mesh.isSkinnedMesh ? paint(mesh, outfit) : false;

    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const cloned = list.map((material) => {
      const copy = (material as THREE.MeshStandardMaterial).clone();
      copy.vertexColors = painted;
      copy.color.setHex(painted ? 0xffffff : outfit.tunic);
      return copy;
    });
    mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0];
  });
}
