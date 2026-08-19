/**
 * Which way an elongated model points.
 *
 * Aligning a model's longest axis still leaves it facing either way down it.
 * The arrow that shipped was modelled pointing backwards, so it sat on the bow
 * facing the archer and every shot flew tail-first — nobody spotted it until
 * the nocked arrow put it under the camera.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { tailAtMax } from '../src/render/models';

/**
 * A shaft running along +z, with a flare of fletching at one end.
 *
 * `flareAt` is where the fat end sits, 0 or 1 along the shaft.
 */
function shaft(flareAt: 0 | 1 | null): THREE.Object3D {
  const points: number[] = [];
  for (let i = 0; i <= 40; i += 1) {
    const z = i / 40;
    const near = flareAt === null ? 0 : Math.abs(z - flareAt);
    const radius = near !== 0 && near < 0.15 ? 0.09 : 0.012;
    for (let a = 0; a < 8; a += 1) {
      const angle = (a / 8) * Math.PI * 2;
      points.push(Math.cos(angle) * radius, Math.sin(angle) * radius, z);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points), 3));
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
}

describe('tailAtMax', () => {
  it('finds the fletching at the far end', () => {
    expect(tailAtMax(shaft(1), 2)).toBe(true);
  });

  it('finds the fletching at the near end', () => {
    expect(tailAtMax(shaft(0), 2)).toBe(false);
  });

  it('leaves a shaft with no flare alone', () => {
    expect(tailAtMax(shaft(null), 2)).toBe(false);
  });

  it('respects the object transform rather than raw vertices', () => {
    // Models arrive nested and rotated; the measurement has to be of the
    // model as it sits, not of numbers in a buffer.
    const holder = new THREE.Group();
    const mesh = shaft(0);
    mesh.rotation.y = Math.PI; // fat end now at +z
    holder.add(mesh);
    expect(tailAtMax(holder, 2)).toBe(true);
  });

  it('says nothing about a model with almost no geometry', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    expect(tailAtMax(new THREE.Mesh(geometry), 2)).toBe(false);
  });
});
