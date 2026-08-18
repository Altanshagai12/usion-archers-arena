/**
 * One archer.
 *
 * The local archer uses a rigged mesh (`archer_rigged`, a 24-joint humanoid
 * skeleton) and is posed procedurally: the bow arm lifts, the string hand draws
 * back to the cheek, the spine leans into the elevation and the chest rises and
 * falls while idling. There is no canned clip — the animation library has no
 * archery action, and a baked loop could not respond to how far the player has
 * drawn anyway, which is the whole game.
 *
 * Bind-pose orientations differ per rig, so every pose is expressed as a small
 * delta from the bone's rest rotation. That way an unexpected rest pose shifts
 * the look slightly instead of turning the archer inside out.
 *
 * The distant opponent uses an unrigged mesh — at 30–75 m the motion would not
 * survive the pixel count, and rigging that mesh fails anyway.
 *
 * Everything hangs off `facingGroup`, inside which local +z is always
 * "down-range".
 */

import * as THREE from 'three';

import { instantiate } from './models';
import type { ModelKey } from './models';

/** Bow hand, used only when there is no skeleton to attach the bow to. */
const LOOSE_BOW_HAND = new THREE.Vector3(0.26, 1.34, 0.44);

interface PoseDelta {
  bone: string;
  /** Rotation at full draw, radians, added to the bone's rest pose. */
  draw: [number, number, number];
  /** Extra rotation applied in proportion to aim elevation. */
  pitch?: [number, number, number];
  /** Constant offset that puts the bone into a shooting stance. */
  base?: [number, number, number];
}

/**
 * Hand-tuned shooting pose. `base` lifts the arms from the rig's A-pose into a
 * bow stance; `draw` is added as the string is pulled.
 */
const POSE: PoseDelta[] = [
  // Bow arm: out and forward, locked nearly straight.
  { bone: 'LeftShoulder', base: [0, 0, -0.15], draw: [0, 0, -0.05] },
  { bone: 'LeftArm', base: [0, -1.15, -0.9], draw: [0, -0.06, 0], pitch: [0, 0, -0.5] },
  { bone: 'LeftForeArm', base: [0, -0.15, 0], draw: [0, 0.05, 0] },
  // String arm: elbow high, hand drawing back toward the cheek.
  { bone: 'RightShoulder', base: [0, 0, 0.18], draw: [0, 0, 0.12] },
  { bone: 'RightArm', base: [0, 1.0, 0.75], draw: [0, 0.45, 0.2], pitch: [0, 0, 0.5] },
  { bone: 'RightForeArm', base: [0, -0.5, 0], draw: [0, -1.15, 0] },
  // Torso squares up to the target and leans back as the draw builds.
  { bone: 'Spine', base: [0, 0.12, 0], draw: [-0.07, 0.05, 0], pitch: [-0.22, 0, 0] },
  { bone: 'Spine01', base: [0, 0.1, 0], draw: [-0.05, 0.04, 0], pitch: [-0.12, 0, 0] },
  { bone: 'Spine02', base: [0, 0.08, 0], draw: [-0.03, 0.03, 0] },
  // Head stays on the target whatever the body does.
  { bone: 'neck', base: [0, -0.1, 0], draw: [0.04, -0.06, 0], pitch: [0.14, 0, 0] },
  { bone: 'Head', base: [0, -0.12, 0], draw: [0.03, -0.05, 0], pitch: [0.12, 0, 0] },
];

export interface ArcherVisualOptions {
  model: ModelKey;
  /** +1 shoots toward +z, -1 toward -z. */
  facing: 1 | -1;
}

export class ArcherRig {
  readonly group = new THREE.Group();

  private readonly facingGroup = new THREE.Group();
  private readonly aimPivot = new THREE.Group();
  private readonly bodyPivot = new THREE.Group();

  private character: THREE.Object3D | null = null;

  private readonly bones = new Map<string, THREE.Bone>();
  private readonly restRotations = new Map<string, THREE.Quaternion>();
  private rigged = false;

  private drawAmount = 0;
  private smoothedDraw = 0;
  private pitch = 0.2;
  private flashUntil = 0;
  private wasFlashing = false;
  private recoil = 0;
  private breathePhase = Math.random() * Math.PI * 2;

  private readonly scratchEuler = new THREE.Euler();
  private readonly scratchQuat = new THREE.Quaternion();

  constructor(options: ArcherVisualOptions) {
    this.facingGroup.rotation.y = options.facing === 1 ? 0 : Math.PI;
    this.group.add(this.facingGroup);
    this.facingGroup.add(this.bodyPivot);

    this.aimPivot.position.copy(LOOSE_BOW_HAND);
    this.facingGroup.add(this.aimPivot);
  }

  async load(options: ArcherVisualOptions): Promise<void> {
    // No separate arrow is attached: the bow mesh is modelled with one already
    // nocked, and adding another put two arrows on the bow.
    const [character, bow, quiver] = await Promise.all([
      instantiate(options.model),
      instantiate('bow'),
      instantiate('quiver'),
    ]);

    this.character = character;
    this.bodyPivot.add(character);
    this.collectBones(character);

    const hand = this.bones.get('LeftHand');
    if (hand) {
      this.rigged = true;
      // Parent the bow to the hand so the two can never drift apart. The hand
      // bone is inside the scaled rig, so undo that scale on the way in.
      const holder = new THREE.Group();
      const scale = this.worldScaleOf(hand);
      holder.scale.setScalar(scale > 0 ? 1 / scale : 1);
      holder.add(bow);
      bow.position.set(0, 0.06, 0.06);
      hand.add(holder);
      this.aimPivot.visible = false;
    } else {
      // No skeleton: hold the bow on a floating pivot, as before.
      this.aimPivot.add(bow);
    }

    quiver.position.set(-0.2, 0.95, -0.14);
    quiver.rotation.set(0.22, 0, 0.3);
    this.bodyPivot.add(quiver);
  }

  private worldScaleOf(node: THREE.Object3D): number {
    const scale = new THREE.Vector3();
    node.updateWorldMatrix(true, false);
    node.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
    return scale.x;
  }

  private collectBones(root: THREE.Object3D): void {
    root.traverse((child) => {
      const bone = child as THREE.Bone;
      if (!bone.isBone) return;
      this.bones.set(bone.name, bone);
      this.restRotations.set(bone.name, bone.quaternion.clone());
    });
  }

  /** Elevation in radians — the number the gauge shows. Aiming is Y only. */
  setAim(pitch: number): void {
    this.pitch = pitch;
  }

  setDraw(amount: number): void {
    this.drawAmount = Math.max(0, Math.min(1, amount));
  }

  release(): void {
    this.drawAmount = 0;
    this.recoil = 1;
  }

  nock(): void {
    // The bow carries its own arrow; nothing to show or hide.
  }

  flashHit(): void {
    this.flashUntil = performance.now() + 340;
  }

  private applyBone(delta: PoseDelta, draw: number, pitchAmount: number): void {
    const bone = this.bones.get(delta.bone);
    const rest = this.restRotations.get(delta.bone);
    if (!bone || !rest) return;

    const base = delta.base ?? [0, 0, 0];
    const pitchTerm = delta.pitch ?? [0, 0, 0];
    this.scratchEuler.set(
      base[0] + delta.draw[0] * draw + pitchTerm[0] * pitchAmount,
      base[1] + delta.draw[1] * draw + pitchTerm[1] * pitchAmount,
      base[2] + delta.draw[2] * draw + pitchTerm[2] * pitchAmount,
    );
    this.scratchQuat.setFromEuler(this.scratchEuler);
    bone.quaternion.copy(rest).multiply(this.scratchQuat);
  }

  update(nowMs: number, deltaSeconds = 1 / 60): void {
    // Ease the draw so releasing snaps rather than teleports.
    this.smoothedDraw += (this.drawAmount - this.smoothedDraw) * Math.min(1, deltaSeconds * 14);

    if (this.rigged) {
      // Normalised elevation, so the lean reads the same at every arena.
      const pitchAmount = Math.max(-0.3, Math.min(1, this.pitch / 0.79));
      for (const delta of POSE) this.applyBone(delta, this.smoothedDraw, pitchAmount);

      // Breathing: a slow rise and fall, damped almost away at full draw.
      const hips = this.bones.get('Hips');
      const hipsRest = this.restRotations.get('Hips');
      if (hips && hipsRest) {
        this.breathePhase += deltaSeconds * 1.9;
        const calm = 1 - this.smoothedDraw * 0.75;
        this.scratchEuler.set(Math.sin(this.breathePhase) * 0.02 * calm, 0, 0);
        this.scratchQuat.setFromEuler(this.scratchEuler);
        hips.quaternion.copy(hipsRest).multiply(this.scratchQuat);
        hips.position.y += 0; // position stays on the rig; rotation carries the motion
      }
    } else {
      // Unrigged stand-in: swing the bow pivot and lean the body.
      this.aimPivot.rotation.set(-this.pitch, 0, 0);
      this.bodyPivot.rotation.x = -this.smoothedDraw * 0.05;
    }

    if (this.recoil > 0) {
      this.recoil = Math.max(0, this.recoil - deltaSeconds * 5.5);
      const kick = this.recoil * 0.09;
      if (this.rigged) this.facingGroup.position.z = -kick;
      else this.aimPivot.position.z = LOOSE_BOW_HAND.z - kick;
    }

    const flashing = nowMs < this.flashUntil;
    if (!this.character || (!flashing && !this.wasFlashing)) {
      this.wasFlashing = flashing;
      return;
    }
    this.wasFlashing = flashing;
    this.character.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        const standard = material as THREE.MeshStandardMaterial;
        if (!standard || !standard.emissive) continue;
        standard.emissive.setHex(flashing ? 0xff3b30 : 0x000000);
        standard.emissiveIntensity = flashing ? 0.6 : 0;
      }
    });
  }

  dispose(): void {
    this.group.removeFromParent();
  }
}
