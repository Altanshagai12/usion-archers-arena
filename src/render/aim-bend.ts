/**
 * Bending animated bones to the shot's elevation.
 *
 * Aiming up and down has to move the BOW, not just the arrow, and the bow is
 * skinned to a hand the clip controls — so the aim is added on top of the
 * animation by rotating the spine after the mixer has run.
 *
 * That is where it gets sharp. `AnimationMixer` does not write a bone whose
 * animated value has not changed since the previous frame: `PropertyMixer`
 * compares the freshly accumulated value against the last one it applied and
 * skips the scene graph entirely when they match. So while an archer stands
 * still — the draw clip held at one time, nothing moving — the spine is never
 * rewritten, and a rotation applied on top of it accumulates instead of being
 * replaced. Both archers slowly spun on the spot.
 *
 * The fix is to never rely on the mixer to undo our work. The clip's own pose
 * is remembered, put back BEFORE the mixer runs — so the bone holds the right
 * value whether or not the mixer bothers to write it — and the bend is
 * reapplied to it afterwards.
 */

import * as THREE from 'three';

interface Bent {
  bone: THREE.Bone;
  /** Fraction of the total elevation this bone carries. */
  share: number;
  /** The clip's own rotation, without our bend. */
  pose: THREE.Quaternion;
  bent: boolean;
}

export class AimBend {
  private readonly bones: Bent[] = [];
  private readonly axis = new THREE.Vector3();
  private readonly parentSpace = new THREE.Matrix4();
  private readonly tilt = new THREE.Quaternion();

  get size(): number {
    return this.bones.length;
  }

  add(bone: THREE.Bone, share: number): void {
    this.bones.push({ bone, share, pose: bone.quaternion.clone(), bent: false });
  }

  /** Put the clip's pose back. Call BEFORE the mixer updates. */
  restore(): void {
    for (const entry of this.bones) {
      if (!entry.bent) continue;
      entry.bone.quaternion.copy(entry.pose);
      entry.bent = false;
    }
  }

  /**
   * Bend to `angle` radians about `worldAxis`. Call AFTER the mixer updates.
   *
   * The axis is given in world space and converted into each bone's parent
   * space, because Mixamo's spine bones do not share the world's axes —
   * turning one about its own x bends the archer sideways.
   */
  bend(worldAxis: THREE.Vector3, angle: number): void {
    for (const entry of this.bones) {
      // Whatever the mixer just wrote is the pose to bend from, and the pose
      // to put back next frame.
      entry.pose.copy(entry.bone.quaternion);
      const parent = entry.bone.parent;
      if (angle === 0 || !parent) continue;

      parent.updateWorldMatrix(true, false);
      this.parentSpace.copy(parent.matrixWorld).invert();
      this.axis.copy(worldAxis).transformDirection(this.parentSpace);
      if (this.axis.lengthSq() < 1e-12) continue;

      this.tilt.setFromAxisAngle(this.axis.normalize(), angle * entry.share);
      entry.bone.quaternion.premultiply(this.tilt);
      entry.bent = true;
    }
  }
}
