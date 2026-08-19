/**
 * The archer's clothes are painted onto its own vertices from the bones that
 * move them, so these tests work on the real Mixamo skeleton: the whole idea
 * rests on those names, and the ordering of the rules is easy to get wrong —
 * every finger bone is a "Hand", and a "ForeArm" is also an "Arm".
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { dressCharacter, outfitFor, regionOf } from '../src/render/outfit';

/** The skeleton the shipped character actually carries, in its own order. */
const SKELETON = [
  'mixamorigHips', 'mixamorigSpine', 'mixamorigSpine1', 'mixamorigSpine2',
  'mixamorigNeck', 'mixamorigHead', 'mixamorigHeadTop_End',
  'mixamorigRightShoulder', 'mixamorigRightArm', 'mixamorigRightForeArm',
  'mixamorigRightHand', 'mixamorigRightHandThumb1', 'mixamorigRightHandIndex2',
  'mixamorigRightHandPinky4',
  'mixamorigLeftShoulder', 'mixamorigLeftArm', 'mixamorigLeftForeArm',
  'mixamorigLeftHand', 'mixamorigLeftHandMiddle3',
  'mixamorigRightUpLeg', 'mixamorigRightLeg', 'mixamorigRightFoot',
  'mixamorigRightToeBase', 'mixamorigRightToe_End',
  'mixamorigLeftUpLeg', 'mixamorigLeftLeg', 'mixamorigLeftFoot',
  'mixamorigLeftToeBase', 'mixamorigLeftToe_End',
];

const OUTFIT = outfitFor(0x56b7f0);

function bytesOf(hex: number): [number, number, number] {
  const colour = new THREE.Color().setHex(hex);
  return [
    Math.round(colour.r * 255),
    Math.round(colour.g * 255),
    Math.round(colour.b * 255),
  ];
}

/** One vertex per entry, each fully weighted to one bone at a given height. */
function skinned(vertices: Array<{ bone: number; y: number }>, skin = true): THREE.SkinnedMesh {
  const geometry = new THREE.BufferGeometry();
  const position = new Float32Array(vertices.length * 3);
  vertices.forEach((vertex, i) => {
    position[i * 3 + 1] = vertex.y;
  });
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));

  if (skin) {
    const index = new Uint16Array(vertices.length * 4);
    const weight = new Float32Array(vertices.length * 4);
    vertices.forEach((vertex, i) => {
      index[i * 4] = vertex.bone;
      // A second, lighter bone on every vertex, so "the heaviest bone wins"
      // is actually exercised rather than being true by default.
      index[i * 4 + 1] = (vertex.bone + 1) % SKELETON.length;
      weight[i * 4] = 0.7;
      weight[i * 4 + 1] = 0.3;
    });
    geometry.setAttribute('skinIndex', new THREE.BufferAttribute(index, 4));
    geometry.setAttribute('skinWeight', new THREE.BufferAttribute(weight, 4));
  }

  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial());
  mesh.bind(
    new THREE.Skeleton(
      SKELETON.map((name) => {
        const bone = new THREE.Bone();
        bone.name = name;
        return bone;
      }),
    ),
  );
  return mesh;
}

function colourAt(mesh: THREE.Object3D, vertex: number): [number, number, number] {
  const attribute = (mesh as THREE.SkinnedMesh).geometry.getAttribute('color');
  const array = attribute.array as Uint8Array;
  return [array[vertex * 3], array[vertex * 3 + 1], array[vertex * 3 + 2]];
}

describe('regionOf', () => {
  it('dresses every bone of the real skeleton', () => {
    const expected: Record<string, string> = {
      mixamorigHips: 'trousers',
      mixamorigSpine: 'tunic',
      mixamorigSpine2: 'tunic',
      mixamorigNeck: 'skin',
      mixamorigHead: 'skin',
      mixamorigHeadTop_End: 'skin',
      mixamorigRightShoulder: 'tunic',
      mixamorigRightArm: 'tunic',
      mixamorigRightForeArm: 'leather',
      mixamorigRightHand: 'skin',
      mixamorigRightHandThumb1: 'skin',
      mixamorigRightHandIndex2: 'skin',
      mixamorigRightHandPinky4: 'skin',
      mixamorigRightUpLeg: 'trousers',
      mixamorigRightLeg: 'trousers',
      mixamorigRightFoot: 'boots',
      mixamorigRightToeBase: 'boots',
      mixamorigRightToe_End: 'boots',
    };
    for (const [bone, region] of Object.entries(expected)) {
      expect(regionOf(bone), bone).toBe(region);
    }
    // Left and right wear the same thing.
    for (const bone of SKELETON) {
      expect(regionOf(bone), bone).toBe(regionOf(bone.replace(/Right/, 'Left')));
    }
  });

  it('reads a forearm as a bracer, not a sleeve', () => {
    // 'ForeArm' contains 'Arm'; the narrower rule has to win.
    expect(regionOf('mixamorigLeftForeArm')).toBe('leather');
    expect(regionOf('mixamorigLeftArm')).toBe('tunic');
  });

  it('reads a finger as a hand, not a sleeve', () => {
    expect(regionOf('mixamorigLeftHandRing3')).toBe('skin');
  });

  it('survives the punctuation three strips on import', () => {
    // Node names arrive as either 'mixamorig:LeftFoot' or 'mixamorigLeftFoot'.
    expect(regionOf('mixamorig:LeftFoot')).toBe('boots');
    expect(regionOf('LeftFoot')).toBe('boots');
  });
});

describe('dressCharacter', () => {
  it('paints each body part in its own garment', () => {
    const head = SKELETON.indexOf('mixamorigHead');
    const spine = SKELETON.indexOf('mixamorigSpine1');
    const forearm = SKELETON.indexOf('mixamorigLeftForeArm');
    const shin = SKELETON.indexOf('mixamorigLeftLeg');
    const foot = SKELETON.indexOf('mixamorigLeftFoot');

    const mesh = skinned([
      { bone: head, y: 1.7 },
      { bone: spine, y: 1.3 },
      { bone: forearm, y: 1.2 },
      { bone: shin, y: 0.4 },
      { bone: foot, y: 0.05 },
    ]);
    dressCharacter(mesh, OUTFIT);

    expect(colourAt(mesh, 0)).toEqual(bytesOf(OUTFIT.skin));
    expect(colourAt(mesh, 1)).toEqual(bytesOf(OUTFIT.tunic));
    expect(colourAt(mesh, 2)).toEqual(bytesOf(OUTFIT.leather));
    expect(colourAt(mesh, 3)).toEqual(bytesOf(OUTFIT.trousers));
    expect(colourAt(mesh, 4)).toEqual(bytesOf(OUTFIT.boots));
  });

  it('belts the top of the pelvis', () => {
    const hips = SKELETON.indexOf('mixamorigHips');
    const mesh = skinned([
      { bone: hips, y: 1 },
      { bone: hips, y: 0.9 },
      { bone: hips, y: 0.5 },
      { bone: hips, y: 0 },
    ]);
    dressCharacter(mesh, OUTFIT);

    expect(colourAt(mesh, 0)).toEqual(bytesOf(OUTFIT.belt));
    expect(colourAt(mesh, 1)).toEqual(bytesOf(OUTFIT.belt));
    expect(colourAt(mesh, 2)).toEqual(bytesOf(OUTFIT.trousers));
    expect(colourAt(mesh, 3)).toEqual(bytesOf(OUTFIT.trousers));
  });

  it('gives the two archers different tunics and nothing else', () => {
    const spine = SKELETON.indexOf('mixamorigSpine1');
    const foot = SKELETON.indexOf('mixamorigLeftFoot');
    const you = skinned([{ bone: spine, y: 1.3 }, { bone: foot, y: 0 }]);
    const foe = skinned([{ bone: spine, y: 1.3 }, { bone: foot, y: 0 }]);
    dressCharacter(you, outfitFor(0x56b7f0));
    dressCharacter(foe, outfitFor(0xe0574f));

    expect(colourAt(you, 0)).toEqual(bytesOf(0x56b7f0));
    expect(colourAt(foe, 0)).toEqual(bytesOf(0xe0574f));
    expect(colourAt(you, 1)).toEqual(colourAt(foe, 1));
  });

  it('switches the material over to vertex colours', () => {
    const mesh = skinned([{ bone: SKELETON.indexOf('mixamorigHead'), y: 1.7 }]);
    dressCharacter(mesh, OUTFIT);
    const material = mesh.material as THREE.MeshStandardMaterial;
    expect(material.vertexColors).toBe(true);
    // White, so the vertex colours come through unmodulated.
    expect(material.color.getHex()).toBe(0xffffff);
  });

  it('leaves an unpaintable mesh flat rather than black', () => {
    // vertexColors with no colour attribute renders the whole figure black,
    // so a mesh that cannot be painted must keep the flat team colour.
    const mesh = skinned([{ bone: 0, y: 1 }], false);
    dressCharacter(mesh, OUTFIT);
    const material = mesh.material as THREE.MeshStandardMaterial;
    expect(material.vertexColors).toBe(false);
    expect(material.color.getHex()).toBe(OUTFIT.tunic);
    expect(mesh.geometry.getAttribute('color')).toBeUndefined();
  });
});
