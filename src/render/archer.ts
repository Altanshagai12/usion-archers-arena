/**
 * One archer.
 *
 * The bow is parented to the hand bone of the character mesh, so it can never
 * drift off into the air — an earlier version hung it on a floating pivot near
 * the chest and it read as a bow orbiting a statue. Which hand is picked is
 * decided by measuring the rig: whichever hand sits further down-range in the
 * bind pose is the bow hand, and the other is the string hand.
 *
 * Motion comes from three things, in order of how much they sell the shot:
 *
 *   1. A drawn bowstring. A line runs from the upper limb tip, through the
 *      string hand, to the lower limb tip, so pulling the shot bends the string
 *      into a deepening V. This is the cue that actually reads as archery.
 *   2. The string hand pulling back, by aiming a single forearm bone at a
 *      target derived from the bind pose. One bone, one bounded rotation.
 *   3. The bow tilting in the hand onto the aim line, the torso leaning into
 *      the draw, and a kick on release.
 *
 * What is deliberately NOT done is solving the whole arm with IK. That was
 * tried; bending an auto-rigged skeleton blind scrambled the figure so badly
 * that hand, bow and arrow could not be told apart. The silhouette is the one
 * thing a player reads, so nothing here is allowed to deform it.
 *
 * Everything hangs off `facingGroup`, inside which local +z is always
 * "down-range".
 */

import * as THREE from 'three';

import { instantiate } from './models';
import type { ModelKey } from './models';

/** Fallback bow position for a mesh with no skeleton to hang it on. */
const LOOSE_BOW_HAND = new THREE.Vector3(0.24, 1.26, 0.34);

/** How far the string hand travels back at full draw, in metres. */
const DRAW_TRAVEL = 0.32;

const FALL_SECONDS = 0.3;
const DOWN_SECONDS = 0.5;
const KNEE_SECONDS = 0.32;
const STAND_SECONDS = 0.5;
const KNOCKED_TOTAL = FALL_SECONDS + DOWN_SECONDS + KNEE_SECONDS + STAND_SECONDS;

const FLAT_ANGLE = 1.5;
const KNEE_ANGLE = 0.55;

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
  private readonly loosePivot = new THREE.Group();
  private readonly bodyPivot = new THREE.Group();

  private character: THREE.Object3D | null = null;
  private bow: THREE.Object3D | null = null;
  /** Wrapper inside the hand bone; carries the aim tilt and the recoil kick. */
  private bowHolder: THREE.Group | null = null;

  private stringForearm: THREE.Bone | null = null;
  private bowUpperArm: THREE.Bone | null = null;
  private readonly restRotations = new Map<THREE.Bone, THREE.Quaternion>();
  /** String hand position at rest, in the archer's own frame. */
  private readonly stringHandRest = new THREE.Vector3();

  private stringLine: THREE.Line | null = null;
  private readonly limbTop = new THREE.Vector3();
  private readonly limbBottom = new THREE.Vector3();

  private drawAmount = 0;
  private smoothedDraw = 0;
  private pitch = 0.2;
  private flashUntil = 0;
  private wasFlashing = false;
  private recoil = 0;
  private knockedFor = -1;
  private breathePhase = Math.random() * Math.PI * 2;

  private readonly scratch = new THREE.Vector3();
  private readonly scratchB = new THREE.Vector3();
  private readonly scratchEuler = new THREE.Euler();
  private readonly scratchQuat = new THREE.Quaternion();

  constructor(options: ArcherVisualOptions) {
    this.facingGroup.rotation.y = options.facing === 1 ? 0 : Math.PI;
    this.group.add(this.facingGroup);
    this.facingGroup.add(this.bodyPivot);

    this.loosePivot.position.copy(LOOSE_BOW_HAND);
    this.facingGroup.add(this.loosePivot);
  }

  async load(options: ArcherVisualOptions): Promise<void> {
    // No separate arrow: the bow mesh is modelled with one already nocked.
    const [character, bow, quiver] = await Promise.all([
      instantiate(options.model),
      instantiate('bow'),
      instantiate('quiver'),
    ]);

    this.character = character;
    this.bow = bow;
    this.bodyPivot.add(character);
    if (options.tint !== undefined) this.applyTint(character, options.tint);

    this.attachBow(character, bow);
    this.buildString(bow);

    quiver.position.set(-0.22, 0.95, -0.16);
    quiver.rotation.set(0.22, 0, 0.32);
    this.bodyPivot.add(quiver);
  }

  private findBone(root: THREE.Object3D, name: string): THREE.Bone | null {
    let found: THREE.Bone | null = null;
    root.traverse((child) => {
      if (!found && (child as THREE.Bone).isBone && child.name === name) {
        found = child as THREE.Bone;
      }
    });
    return found;
  }

  /**
   * Put the bow in a hand. Which hand is measured from the rig rather than
   * assumed: the one further down-range holds the bow.
   */
  private attachBow(character: THREE.Object3D, bow: THREE.Object3D): void {
    const left = this.findBone(character, 'LeftHand');
    const right = this.findBone(character, 'RightHand');

    if (!left || !right) {
      this.loosePivot.add(bow);
      return;
    }

    character.updateWorldMatrix(true, true);
    const leftZ = this.facingGroup.worldToLocal(left.getWorldPosition(this.scratch)).z;
    const rightZ = this.facingGroup.worldToLocal(right.getWorldPosition(this.scratchB)).z;

    const bowHand = leftZ >= rightZ ? left : right;
    const stringHand = bowHand === left ? right : left;

    const holder = new THREE.Group();
    // The hand bone lives inside the scaled rig; undo that on the way in so
    // the bow keeps the size it was normalised to.
    const scale = bowHand.getWorldScale(this.scratch).x;
    holder.scale.setScalar(scale > 0 ? 1 / scale : 1);
    holder.add(bow);
    bowHand.add(holder);
    this.bowHolder = holder;
    this.loosePivot.visible = false;

    this.bowUpperArm = this.findBone(character, bowHand === left ? 'LeftArm' : 'RightArm');
    this.stringForearm = this.findBone(
      character,
      stringHand === left ? 'LeftForeArm' : 'RightForeArm',
    );
    for (const bone of [this.bowUpperArm, this.stringForearm]) {
      if (bone) this.restRotations.set(bone, bone.quaternion.clone());
    }

    // Remember where the string hand rests, so the draw target is derived from
    // the bind pose instead of from the previous frame (which would drift).
    character.updateWorldMatrix(true, true);
    this.facingGroup.worldToLocal(stringHand.getWorldPosition(this.stringHandRest));
  }

  /**
   * A three-point line standing in for the bowstring. The modelled string on
   * the bow mesh is straight; this one bends back to the drawing hand, which is
   * what makes a draw read as a draw.
   */
  private buildString(bow: THREE.Object3D): void {
    const box = new THREE.Box3().setFromObject(bow);
    const size = new THREE.Vector3();
    box.getSize(size);
    // Limb tips in the bow's own frame — it is normalised upright and centred.
    this.limbTop.set(0, size.y * 0.46, 0);
    this.limbBottom.set(0, -size.y * 0.46, 0);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    const material = new THREE.LineBasicMaterial({ color: 0xf4f1e6, transparent: true, opacity: 0.95 });
    const line = new THREE.Line(geometry, material);
    line.frustumCulled = false;
    line.visible = false;
    this.stringLine = line;
    this.group.add(line);
  }

  private applyTint(root: THREE.Object3D, tint: number): void {
    const colour = new THREE.Color(tint);
    root.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const cloned = list.map((material) => {
        const copy = (material as THREE.MeshStandardMaterial).clone();
        copy.color.lerp(colour, 0.28);
        return copy;
      });
      mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0];
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

  /** Take a hit: fall backwards, lie a beat, then get back up. */
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

  /** Rotate one bone so its own axis points at a world-space target. */
  private aimBoneAt(bone: THREE.Bone, worldTarget: THREE.Vector3): void {
    const parent = bone.parent;
    if (!parent) return;
    const child = bone.children.find((c) => (c as THREE.Bone).isBone) as THREE.Bone | undefined;
    if (!child || child.position.lengthSq() < 1e-10) return;

    parent.updateWorldMatrix(true, false);
    this.scratch.copy(worldTarget).applyMatrix4(parent.matrixWorld.clone().invert());
    this.scratch.sub(bone.position);
    if (this.scratch.lengthSq() < 1e-10) return;
    this.scratch.normalize();

    this.scratchB.copy(child.position).normalize();
    bone.quaternion.setFromUnitVectors(this.scratchB, this.scratch);
  }

  private knockdownAngle(elapsed: number): number {
    if (elapsed < FALL_SECONDS) {
      const t = elapsed / FALL_SECONDS;
      return FLAT_ANGLE * (t * t) * (1 + 0.12 * Math.sin(Math.PI * t));
    }
    const afterFall = elapsed - FALL_SECONDS;
    if (afterFall < DOWN_SECONDS) {
      const t = afterFall / DOWN_SECONDS;
      return FLAT_ANGLE * (1 + 0.06 * Math.cos(t * Math.PI * 3) * (1 - t));
    }
    const afterDown = afterFall - DOWN_SECONDS;
    if (afterDown < KNEE_SECONDS) {
      const t = afterDown / KNEE_SECONDS;
      return FLAT_ANGLE + (KNEE_ANGLE - FLAT_ANGLE) * (t * t * (3 - 2 * t));
    }
    const t = Math.min(1, (afterDown - KNEE_SECONDS) / STAND_SECONDS);
    return KNEE_ANGLE * (1 - (1 - (1 - t) * (1 - t)));
  }

  private updateString(draw: number): void {
    const line = this.stringLine;
    const bow = this.bow;
    if (!line || !bow) return;

    if (draw < 0.04) {
      line.visible = false;
      return;
    }

    const positions = line.geometry.getAttribute('position') as THREE.BufferAttribute;

    bow.updateWorldMatrix(true, false);
    this.scratch.copy(this.limbTop).applyMatrix4(bow.matrixWorld);
    positions.setXYZ(0, this.scratch.x, this.scratch.y, this.scratch.z);

    // Nock point: pulled back from the bow's middle along the archer's own
    // backward direction, so the string bends into a V as the shot is drawn.
    this.scratchB.set(0, 0, 0).applyMatrix4(bow.matrixWorld);
    this.facingGroup.worldToLocal(this.scratchB);
    this.scratchB.z -= draw * DRAW_TRAVEL;
    this.facingGroup.localToWorld(this.scratchB);
    positions.setXYZ(1, this.scratchB.x, this.scratchB.y, this.scratchB.z);

    this.scratch.copy(this.limbBottom).applyMatrix4(bow.matrixWorld);
    positions.setXYZ(2, this.scratch.x, this.scratch.y, this.scratch.z);

    positions.needsUpdate = true;
    line.geometry.computeBoundingSphere();
    line.visible = true;
  }

  private pullString(draw: number): void {
    const forearm = this.stringForearm;
    const rest = forearm ? this.restRotations.get(forearm) : null;
    if (!forearm || !rest) return;

    if (draw < 0.02) {
      forearm.quaternion.copy(rest);
      return;
    }

    // Target derived from the bind pose, never from the previous frame, so the
    // arm cannot walk away from itself over time.
    this.scratch.copy(this.stringHandRest);
    this.scratch.z -= draw * DRAW_TRAVEL;
    this.scratch.y += draw * 0.05;
    this.facingGroup.localToWorld(this.scratch);
    this.aimBoneAt(forearm, this.scratch);
  }

  update(nowMs: number, deltaSeconds = 1 / 60): void {
    const dt = Math.min(0.1, Math.max(0.001, deltaSeconds));

    if (this.knockedFor >= 0) {
      this.knockedFor += dt;
      if (this.knockedFor >= KNOCKED_TOTAL) this.knockedFor = -1;
    }

    this.smoothedDraw += (this.drawAmount - this.smoothedDraw) * Math.min(1, dt * 14);
    this.breathePhase += dt * 1.9;

    const angle = this.knockedFor >= 0 ? this.knockdownAngle(this.knockedFor) : 0;
    const down = Math.min(1, angle / FLAT_ANGLE);
    const draw = this.smoothedDraw * (1 - down);

    this.facingGroup.rotation.x = -angle;
    this.facingGroup.position.y = -down * 0.1;

    if (this.recoil > 0) this.recoil = Math.max(0, this.recoil - dt * 5.5);

    // Torso leans into the draw and breathes while idle.
    const settled = (1 - draw * 0.8) * (1 - down);
    this.bodyPivot.rotation.x = -draw * 0.12 + Math.sin(this.breathePhase) * 0.012 * settled;

    // Bow arm lifts with elevation — one bone, a small bounded rotation.
    if (this.bowUpperArm) {
      const rest = this.restRotations.get(this.bowUpperArm);
      if (rest) {
        this.scratchEuler.set(-this.pitch * 0.45 * (1 - down), 0, 0);
        this.scratchQuat.setFromEuler(this.scratchEuler);
        this.bowUpperArm.quaternion.copy(rest).multiply(this.scratchQuat);
      }
    }

    this.pullString(draw);

    // Bow tilts onto the aim line inside the hand, and kicks on release.
    if (this.bowHolder) {
      this.bowHolder.rotation.x = -this.pitch * 0.75 * (1 - down);
      this.bowHolder.position.z = -this.recoil * 0.12;
    } else {
      this.loosePivot.rotation.x = -this.pitch;
      this.loosePivot.position.z = LOOSE_BOW_HAND.z - this.recoil * 0.12;
    }

    // The string is drawn last, once everything it hangs between has moved.
    this.group.updateWorldMatrix(true, true);
    this.updateString(draw);

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
    this.stringLine?.geometry.dispose();
  }
}
