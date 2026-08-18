/**
 * Two-bone inverse kinematics for posing an arm at a world-space target.
 *
 * Hand-authored Euler offsets need to know how a rig's bind pose is oriented,
 * and these skeletons come out of an auto-rigger where that is not knowable in
 * advance. IK sidesteps the problem entirely: each bone's own axis is read from
 * the bind pose (the direction to its child) and rotated onto the direction the
 * solve asks for, so the hand lands where it is told whatever the rest pose
 * happened to be.
 */

import * as THREE from 'three';

const parentInverse = new THREE.Matrix4();
const targetLocal = new THREE.Vector3();
const direction = new THREE.Vector3();
const rootWorld = new THREE.Vector3();
const midWorld = new THREE.Vector3();
const tipWorld = new THREE.Vector3();
const toTarget = new THREE.Vector3();
const poleAxis = new THREE.Vector3();
const bendAxis = new THREE.Vector3();
const elbow = new THREE.Vector3();
const scratch = new THREE.Vector3();

function firstChildBone(bone: THREE.Bone): THREE.Bone | null {
  for (const child of bone.children) {
    if ((child as THREE.Bone).isBone) return child as THREE.Bone;
  }
  return null;
}

/** The direction this bone points in its own local space, from the bind pose. */
export function boneAxis(bone: THREE.Bone, out = new THREE.Vector3()): THREE.Vector3 {
  const child = firstChildBone(bone);
  if (!child || child.position.lengthSq() < 1e-12) return out.set(0, 1, 0);
  return out.copy(child.position).normalize();
}

/** Bind-pose length from this bone to its child, in the rig's own units. */
export function boneLength(bone: THREE.Bone): number {
  const child = firstChildBone(bone);
  return child ? child.position.length() : 0;
}

/** Rotate `bone` so its own axis points at `worldTarget`. */
export function aimBoneAt(bone: THREE.Bone, worldTarget: THREE.Vector3): void {
  const parent = bone.parent;
  if (!parent) return;

  parent.updateWorldMatrix(true, false);
  parentInverse.copy(parent.matrixWorld).invert();

  targetLocal.copy(worldTarget).applyMatrix4(parentInverse);
  direction.copy(targetLocal).sub(bone.position);
  if (direction.lengthSq() < 1e-10) return;
  direction.normalize();

  bone.quaternion.setFromUnitVectors(boneAxis(bone, scratch), direction);
}

/**
 * Bend a two-bone chain so the tip reaches `target`.
 *
 * `pole` is a world-space hint for which way the elbow should break; without
 * it the solve is ambiguous and elbows flip about at random.
 */
export function solveTwoBone(
  root: THREE.Bone,
  mid: THREE.Bone,
  target: THREE.Vector3,
  pole: THREE.Vector3,
): void {
  const upper = boneLength(root);
  const lower = boneLength(mid);
  if (upper <= 0 || lower <= 0) return;

  root.updateWorldMatrix(true, false);
  root.getWorldPosition(rootWorld);

  // Bone lengths are in rig-local units; convert to the world scale the
  // target is expressed in, or the chain solves at the wrong size.
  const scale = root.getWorldScale(scratch).x || 1;
  const l1 = upper * scale;
  const l2 = lower * scale;

  toTarget.copy(target).sub(rootWorld);
  const reach = l1 + l2;
  // Leave a sliver of bend: a perfectly straight chain has no defined plane.
  const distance = Math.min(reach * 0.999, Math.max(Math.abs(l1 - l2) + 1e-4, toTarget.length()));
  if (distance < 1e-6) return;
  toTarget.normalize();

  // Law of cosines: how far off the straight line the elbow sits.
  const cosRoot = (l1 * l1 + distance * distance - l2 * l2) / (2 * l1 * distance);
  const rootAngle = Math.acos(Math.min(1, Math.max(-1, cosRoot)));

  // Build the bend plane from the pole hint, projected perpendicular to the
  // limb so the elbow swings around the limb rather than along it.
  poleAxis.copy(pole).sub(rootWorld);
  poleAxis.addScaledVector(toTarget, -poleAxis.dot(toTarget));
  if (poleAxis.lengthSq() < 1e-8) poleAxis.set(0, 1, 0).addScaledVector(toTarget, -toTarget.y);
  if (poleAxis.lengthSq() < 1e-8) poleAxis.set(1, 0, 0);
  poleAxis.normalize();

  bendAxis.copy(toTarget).multiplyScalar(Math.cos(rootAngle));
  bendAxis.addScaledVector(poleAxis, Math.sin(rootAngle));

  elbow.copy(rootWorld).addScaledVector(bendAxis, l1);

  aimBoneAt(root, elbow);

  // The upper bone moved, so the elbow's world position must be re-read before
  // aiming the forearm at the hand target.
  mid.updateWorldMatrix(true, false);
  mid.getWorldPosition(midWorld);
  tipWorld.copy(target);
  // Keep the forearm within reach so it does not stretch toward a far target.
  scratch.copy(tipWorld).sub(midWorld);
  if (scratch.length() > l2) {
    tipWorld.copy(midWorld).addScaledVector(scratch.normalize(), l2);
  }
  aimBoneAt(mid, tipWorld);
}
