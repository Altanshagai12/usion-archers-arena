/**
 * Procedural stand-ins for the generated meshes.
 *
 * A match must never fail to start because a .glb did not arrive — a flaky
 * network, a cache miss or a bad deploy would otherwise leave the player
 * staring at a frozen screen. Every model load falls back to one of these, so
 * the worst case is a plainer-looking duel that still plays correctly.
 */

import * as THREE from 'three';

import type { ModelKey } from './models';

function mesh(
  geometry: THREE.BufferGeometry,
  colour: number,
  roughness = 0.85,
): THREE.Mesh {
  const material = new THREE.MeshStandardMaterial({ color: colour, roughness, metalness: 0 });
  const node = new THREE.Mesh(geometry, material);
  node.castShadow = true;
  node.receiveShadow = true;
  return node;
}

/** A blocky humanoid whose proportions match the sim's hit volumes. */
function archer(tunic: number): THREE.Group {
  const group = new THREE.Group();

  const legs = mesh(new THREE.BoxGeometry(0.42, 0.84, 0.34), 0x4a4237);
  legs.position.y = 0.42;
  group.add(legs);

  const torso = mesh(new THREE.BoxGeometry(0.56, 0.66, 0.38), tunic);
  torso.position.y = 1.15;
  group.add(torso);

  const head = mesh(new THREE.SphereGeometry(0.19, 16, 12), 0xe8c39e);
  head.position.y = 1.62;
  group.add(head);

  const hood = mesh(new THREE.ConeGeometry(0.24, 0.3, 12), tunic);
  hood.position.y = 1.82;
  group.add(hood);

  return group;
}

function bow(): THREE.Group {
  const group = new THREE.Group();
  const limb = mesh(new THREE.TorusGeometry(0.5, 0.035, 8, 20, Math.PI * 1.1), 0x8b5a2b, 0.7);
  limb.rotation.z = Math.PI / 2 - (Math.PI * 1.1) / 2;
  group.add(limb);

  const string = mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.98, 5), 0xf2f2f2, 0.5);
  string.position.x = 0.16;
  group.add(string);
  return group;
}

function arrow(): THREE.Group {
  const group = new THREE.Group();
  const shaft = mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.72, 6), 0xc9a227, 0.7);
  shaft.rotation.z = Math.PI / 2;
  group.add(shaft);

  const tip = mesh(new THREE.ConeGeometry(0.045, 0.13, 6), 0xd8dce2, 0.4);
  tip.rotation.z = -Math.PI / 2;
  tip.position.x = 0.42;
  group.add(tip);

  const fletch = mesh(new THREE.BoxGeometry(0.12, 0.09, 0.01), 0xf87171, 0.9);
  fletch.position.x = -0.3;
  group.add(fletch);
  return group;
}

function tree(): THREE.Group {
  const group = new THREE.Group();
  const trunk = mesh(new THREE.CylinderGeometry(0.22, 0.3, 2.6, 7), 0x6b4a2f);
  trunk.position.y = 1.3;
  group.add(trunk);
  for (let i = 0; i < 3; i += 1) {
    const tier = mesh(new THREE.ConeGeometry(1.5 - i * 0.36, 1.9, 8), 0x3f6b32);
    tier.position.y = 2.5 + i * 1.15;
    group.add(tier);
  }
  return group;
}

/** One post-and-two-rail section, the kind lining a shooting range. */
function fence(): THREE.Group {
  const group = new THREE.Group();
  const wood = 0x8a6a44;

  for (const x of [-2.2, 2.2]) {
    const post = mesh(new THREE.BoxGeometry(0.12, 1.3, 0.12), wood);
    post.position.set(x, 0.65, 0);
    group.add(post);
  }
  for (const y of [0.55, 1.05]) {
    const rail = mesh(new THREE.BoxGeometry(4.5, 0.09, 0.07), wood);
    rail.position.set(0, y, 0);
    group.add(rail);
  }
  return group;
}

/** Straw butt with painted rings, on a low stand. */
function target(): THREE.Group {
  const group = new THREE.Group();

  const legs = mesh(new THREE.BoxGeometry(0.9, 0.12, 0.5), 0x6b4a2f);
  legs.position.y = 0.06;
  group.add(legs);

  const butt = new THREE.Mesh(
    new THREE.CylinderGeometry(0.62, 0.62, 0.17, 22),
    new THREE.MeshStandardMaterial({ color: 0xd6c187, roughness: 0.95 }),
  );
  butt.rotation.x = Math.PI / 2;
  butt.position.y = 0.75;
  butt.castShadow = true;
  butt.receiveShadow = true;
  group.add(butt);

  // Rings sit a hair proud of the face so they never z-fight with it.
  const rings: Array<[number, number]> = [
    [0.62, 0xf4f4f4],
    [0.42, 0xd8453c],
    [0.2, 0xf4f4f4],
  ];
  rings.forEach(([radius, colour], index) => {
    const face = new THREE.Mesh(
      new THREE.CircleGeometry(radius, 24),
      new THREE.MeshStandardMaterial({ color: colour, roughness: 0.9 }),
    );
    face.position.set(0, 0.75, 0.087 + index * 0.004);
    group.add(face);
  });

  return group;
}

const SIMPLE: Partial<Record<ModelKey, () => THREE.Object3D>> = {
  fence,
  target,
  archer_a: () => archer(0xb03a3a),
  archer_b: () => archer(0x2f5fa8),
  bow,
  arrow,
  tree,
  rock: () => mesh(new THREE.DodecahedronGeometry(0.75, 0), 0x7c7f86),
  crate: () => mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), 0x8a6236),
  quiver: () => mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.55, 8), 0x6b4a2f),
  ruin_column: () => mesh(new THREE.CylinderGeometry(0.38, 0.44, 4, 10), 0xc7bda0),
  castle_wall: () => mesh(new THREE.BoxGeometry(8, 7.5, 1.6), 0x8d9098),
  castle_tower: () => mesh(new THREE.CylinderGeometry(1.9, 2.2, 12, 12), 0x8d9098),
  banner: () => mesh(new THREE.BoxGeometry(0.7, 3.4, 0.06), 0x2f3d63),
};

/**
 * Build a stand-in for `key`, already normalised the same way `models.ts`
 * normalises a loaded glb: centred on its footprint with its base at y = 0.
 */
export function fallbackModel(key: ModelKey): THREE.Group {
  const build = SIMPLE[key];
  const node = build ? build() : mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), 0x9aa0a6);

  const wrapper = new THREE.Group();
  wrapper.add(node);

  const box = new THREE.Box3().setFromObject(wrapper);
  node.position.y -= box.min.y;
  return wrapper;
}
