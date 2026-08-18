/**
 * One archer, with a small animation state machine driving a rigged skeleton.
 *
 *   idle      slow sway and breathing
 *   aiming    bow arm locks onto the aim line, string hand draws to the jaw
 *   release   string hand snaps forward, bow kicks, body follows through
 *   knocked   a hit knocks the archer flat, then they push back up
 *
 * The arms are posed with two-bone IK against world-space targets rather than
 * with hand-authored bone rotations. These skeletons come from an auto-rigger,
 * so the bind pose is not knowable in advance; IK reads each bone's own axis
 * from the rig and puts the hand where it is told regardless.
 *
 * Everything hangs off `facingGroup`, inside which local +z is always
 * "down-range".
 */

import * as THREE from 'three';

import { solveTwoBone } from './ik';
import { instantiate } from './models';
import type { ModelKey } from './models';

/** Where the bow sits when there is no skeleton to attach it to. */
const LOOSE_BOW_HAND = new THREE.Vector3(0.26, 1.34, 0.44);

const FALL_SECONDS = 0.32;
const DOWN_SECONDS = 0.55;
const RISE_SECONDS = 0.75;
const KNOCKED_TOTAL = FALL_SECONDS + DOWN_SECONDS + RISE_SECONDS;

/** Small lean/twist offsets, applied as deltas from each bone's rest pose. */
interface TorsoDelta {
  bone: string;
  base?: [number, number, number];
  draw?: [number, number, number];
  pitch?: [number, number, number];
}

const TORSO: TorsoDelta[] = [
  { bone: 'Spine', base: [0, 0.1, 0], draw: [-0.06, 0.04, 0], pitch: [-0.16, 0, 0] },
  { bone: 'Spine01', base: [0, 0.08, 0], draw: [-0.04, 0.03, 0], pitch: [-0.1, 0, 0] },
  { bone: 'Spine02', base: [0, 0.06, 0], draw: [-0.02, 0.02, 0], pitch: [-0.06, 0, 0] },
  { bone: 'neck', base: [0, -0.08, 0], draw: [0.03, -0.04, 0], pitch: [0.1, 0, 0] },
  { bone: 'Head', base: [0, -0.1, 0], draw: [0.02, -0.04, 0], pitch: [0.1, 0, 0] },
];

export interface ArcherVisualOptions {
  model: ModelKey;
  /** +1 shoots toward +z, -1 toward -z. */
  facing: 1 | -1;
  /** Blended into the character's base colour to tell the two sides apart. */
  tint?: number;
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
  private knockedFor = -1;
  private breathePhase = Math.random() * Math.PI * 2;
  private swayPhase = Math.random() * Math.PI * 2;

  private readonly scratchEuler = new THREE.Euler();
  private readonly scratchQuat = new THREE.Quaternion();
  private readonly bowTarget = new THREE.Vector3();
  private readonly drawTarget = new THREE.Vector3();
  private readonly poleA = new THREE.Vector3();
  private readonly poleB = new THREE.Vector3();

  constructor(options: ArcherVisualOptions) {
    this.facingGroup.rotation.y = options.facing === 1 ? 0 : Math.PI;
    this.group.add(this.facingGroup);
    this.facingGroup.add(this.bodyPivot);

    this.aimPivot.position.copy(LOOSE_BOW_HAND);
    this.facingGroup.add(this.aimPivot);
  }

  async load(options: ArcherVisualOptions): Promise<void> {
    // No separate arrow: the bow mesh is modelled with one already nocked, and
    // attaching another put two arrows on the bow.
    const [character, bow, quiver] = await Promise.all([
      instantiate(options.model),
      instantiate('bow'),
      instantiate('quiver'),
    ]);

    this.character = character;
    this.bodyPivot.add(character);
    this.collectBones(character);
    if (options.tint !== undefined) this.applyTint(character, options.tint);

    const hand = this.bones.get('LeftHand');
    if (hand) {
      this.rigged = true;
      // Parent the bow to the hand so the two can never drift apart. The hand
      // bone lives inside the scaled rig, so undo that scale on the way in.
      const holder = new THREE.Group();
      const scale = hand.getWorldScale(new THREE.Vector3()).x;
      holder.scale.setScalar(scale > 0 ? 1 / scale : 1);
      holder.add(bow);
      bow.position.set(0, 0.06, 0.06);
      hand.add(holder);
      this.aimPivot.visible = false;
    } else {
      this.aimPivot.add(bow);
    }

    quiver.position.set(-0.2, 0.95, -0.14);
    quiver.rotation.set(0.22, 0, 0.3);
    this.bodyPivot.add(quiver);
  }

  /** Clone materials before tinting so the two archers stay independent. */
  private applyTint(root: THREE.Object3D, tint: number): void {
    const colour = new THREE.Color(tint);
    root.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const cloned = list.map((material) => {
        const copy = (material as THREE.MeshStandardMaterial).clone();
        copy.color.lerp(colour, 0.5);
        return copy;
      });
      mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0];
    });
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

  /** Take a hit: stagger, go down, then get back up. */
  knockDown(): void {
    this.flashUntil = performance.now() + 340;
    this.knockedFor = 0;
    this.drawAmount = 0;
  }

  get isKnockedDown(): boolean {
    return this.knockedFor >= 0;
  }

  flashHit(): void {
    this.flashUntil = performance.now() + 340;
  }

  private applyTorso(draw: number, pitchAmount: number): void {
    for (const delta of TORSO) {
      const bone = this.bones.get(delta.bone);
      const rest = this.restRotations.get(delta.bone);
      if (!bone || !rest) continue;
      const base = delta.base ?? [0, 0, 0];
      const drawTerm = delta.draw ?? [0, 0, 0];
      const pitchTerm = delta.pitch ?? [0, 0, 0];
      this.scratchEuler.set(
        base[0] + drawTerm[0] * draw + pitchTerm[0] * pitchAmount,
        base[1] + drawTerm[1] * draw + pitchTerm[1] * pitchAmount,
        base[2] + drawTerm[2] * draw + pitchTerm[2] * pitchAmount,
      );
      this.scratchQuat.setFromEuler(this.scratchEuler);
      bone.quaternion.copy(rest).multiply(this.scratchQuat);
    }
  }

  private poseArms(draw: number, sway: number, down: number): void {
    const bowArm = this.bones.get('LeftArm');
    const bowForearm = this.bones.get('LeftForeArm');
    const drawArm = this.bones.get('RightArm');
    const drawForearm = this.bones.get('RightForeArm');
    if (!bowArm || !bowForearm || !drawArm || !drawForearm) return;

    const sin = Math.sin(this.pitch);
    const cos = Math.cos(this.pitch);

    // Bow hand: out at arm's length along the aim line, so raising the
    // elevation visibly lifts the whole bow arm. While down, both arms fall in
    // toward the body instead of holding a bow up at nothing.
    this.bowTarget.set(
      0.16 + sway * 0.4,
      THREE.MathUtils.lerp(1.36 + sin * 0.62, 0.75, down),
      THREE.MathUtils.lerp(0.48 * cos + 0.12, 0.12, down),
    );
    // String hand: at the jaw, sliding back as the draw builds.
    this.drawTarget.set(
      -0.13,
      THREE.MathUtils.lerp(1.5 + sin * 0.5, 0.8, down),
      THREE.MathUtils.lerp(0.2 - draw * 0.34, -0.1, down),
    );

    this.facingGroup.localToWorld(this.bowTarget);
    this.facingGroup.localToWorld(this.drawTarget);

    // Elbow hints: the bow elbow rolls down and out, the string elbow stays
    // high — the classic archery silhouette.
    this.poleA.set(0.9, 0.4, 0.3);
    this.poleB.set(-0.7, 1.7, -0.6);
    this.facingGroup.localToWorld(this.poleA);
    this.facingGroup.localToWorld(this.poleB);

    solveTwoBone(bowArm, bowForearm, this.bowTarget, this.poleA);
    solveTwoBone(drawArm, drawForearm, this.drawTarget, this.poleB);
  }

  /** 0 while upright, 1 flat on the ground. */
  private knockdownAmount(elapsed: number): number {
    if (elapsed < FALL_SECONDS) {
      const t = elapsed / FALL_SECONDS;
      return t * t; // accelerating fall
    }
    if (elapsed < FALL_SECONDS + DOWN_SECONDS) return 1;
    const t = (elapsed - FALL_SECONDS - DOWN_SECONDS) / RISE_SECONDS;
    // Ease out of the rise so standing up settles instead of snapping.
    return 1 - t * t * (3 - 2 * t);
  }

  update(nowMs: number, deltaSeconds = 1 / 60): void {
    const dt = Math.min(0.1, Math.max(0.001, deltaSeconds));

    if (this.knockedFor >= 0) {
      this.knockedFor += dt;
      if (this.knockedFor >= KNOCKED_TOTAL) this.knockedFor = -1;
    }

    // Ease the draw so releasing snaps rather than teleports.
    this.smoothedDraw += (this.drawAmount - this.smoothedDraw) * Math.min(1, dt * 14);
    this.breathePhase += dt * 1.9;
    this.swayPhase += dt * 0.7;

    const down = this.knockedFor >= 0 ? this.knockdownAmount(this.knockedFor) : 0;

    // Root: fall backwards about the feet, and drop as the body goes over.
    this.facingGroup.rotation.x = -down * 1.42;
    this.facingGroup.position.y = -down * 0.12;

    if (this.recoil > 0) {
      this.recoil = Math.max(0, this.recoil - dt * 5.5);
      const kick = this.recoil * 0.09;
      if (this.rigged) this.facingGroup.position.z = -kick;
      else this.aimPivot.position.z = LOOSE_BOW_HAND.z - kick;
    }

    if (this.rigged) {
      // Idle sway fades out as the shot is drawn and while flat on the ground.
      const settled = (1 - this.smoothedDraw * 0.8) * (1 - down);
      const sway = Math.sin(this.swayPhase) * 0.035 * settled;
      const pitchAmount = Math.max(-0.3, Math.min(1, this.pitch / 0.79));

      this.applyTorso(this.smoothedDraw, pitchAmount * (1 - down));

      const hips = this.bones.get('Hips');
      const hipsRest = this.restRotations.get('Hips');
      if (hips && hipsRest) {
        const breathe = Math.sin(this.breathePhase) * 0.022 * settled;
        this.scratchEuler.set(breathe, sway * 0.6, sway * 0.4);
        this.scratchQuat.setFromEuler(this.scratchEuler);
        hips.quaternion.copy(hipsRest).multiply(this.scratchQuat);
      }

      // The torso moved the shoulders, so refresh before solving the arms.
      this.group.updateWorldMatrix(true, true);
      this.poseArms(this.smoothedDraw, sway, down);
    } else {
      this.aimPivot.rotation.set(-this.pitch, 0, 0);
      this.bodyPivot.rotation.x = -this.smoothedDraw * 0.05;
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
