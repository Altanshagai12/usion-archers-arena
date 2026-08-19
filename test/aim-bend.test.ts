/**
 * The aim bend must be idempotent frame to frame.
 *
 * The bug this covers: `AnimationMixer` skips writing a bone whose animated
 * value has not changed since the last frame, so an archer standing still
 * never has its spine rewritten — and a rotation applied on top of it every
 * frame accumulates instead of being replaced. Both archers spun on the spot.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { AimBend } from '../src/render/aim-bend';

const LANE = new THREE.Vector3(1, 0, 0);

/** A bone under a parent, the way a spine bone hangs off the one below it. */
function spine(): { bone: THREE.Bone; parent: THREE.Object3D } {
  const parent = new THREE.Object3D();
  // Rotated, so a bone's own axes are NOT the world's — which is the whole
  // reason the bend is given a world axis to convert rather than a local one.
  parent.rotation.set(0.3, 0.8, -0.2);
  const bone = new THREE.Bone();
  parent.add(bone);
  parent.updateMatrixWorld(true);
  return { bone, parent };
}

function angleOf(bone: THREE.Bone): number {
  return 2 * Math.acos(Math.min(1, Math.abs(bone.quaternion.w)));
}

describe('AimBend', () => {
  it('lands on the same rotation however many frames pass', () => {
    const { bone } = spine();
    const aim = new AimBend();
    aim.add(bone, 0.5);

    aim.bend(LANE, 0.6);
    const first = bone.quaternion.clone();

    // Twenty frames of a mixer that writes nothing, because nothing moved.
    for (let frame = 0; frame < 20; frame += 1) {
      aim.restore();
      aim.bend(LANE, 0.6);
    }

    expect(bone.quaternion.angleTo(first)).toBeLessThan(1e-6);
  });

  it('bends further as the shot is raised, and unwinds again', () => {
    const { bone } = spine();
    const aim = new AimBend();
    aim.add(bone, 1);

    aim.bend(LANE, 0.2);
    const low = angleOf(bone);
    aim.restore();
    aim.bend(LANE, 0.7);
    const high = angleOf(bone);
    expect(high).toBeGreaterThan(low);

    aim.restore();
    aim.bend(LANE, 0);
    expect(angleOf(bone)).toBeLessThan(1e-6);
  });

  it('follows the clip when the clip does move', () => {
    const { bone } = spine();
    const aim = new AimBend();
    aim.add(bone, 1);
    aim.bend(LANE, 0.4);

    // Next frame: restore, then the "mixer" writes a new pose over it.
    aim.restore();
    const posed = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.9);
    bone.quaternion.copy(posed);
    aim.bend(LANE, 0.4);

    // The bend is on top of the NEW pose, not the old one.
    aim.restore();
    expect(bone.quaternion.angleTo(posed)).toBeLessThan(1e-6);
  });

  it('restores nothing it did not bend', () => {
    const { bone } = spine();
    const aim = new AimBend();
    aim.add(bone, 1);

    // A frame with no elevation leaves the bone alone entirely...
    aim.bend(LANE, 0);
    const posed = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.5);
    bone.quaternion.copy(posed);
    // ...so a later restore must not stomp what the clip put there.
    aim.restore();
    expect(bone.quaternion.angleTo(posed)).toBeLessThan(1e-6);
  });

  it('splits the elevation across the bones it was given', () => {
    const one = spine();
    const two = spine();
    const aim = new AimBend();
    aim.add(one.bone, 0.25);
    aim.add(two.bone, 0.75);
    aim.bend(LANE, 0.8);

    expect(aim.size).toBe(2);
    expect(angleOf(two.bone)).toBeGreaterThan(angleOf(one.bone));
  });
});
