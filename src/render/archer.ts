/**
 * One archer.
 *
 * Everything animated here is a transform on a group the game owns — the bow
 * pivot, the torso, the root. Nothing reaches into the skeleton.
 *
 * That is deliberate. An earlier version posed the arms with IK against the
 * auto-rigged skeleton, and the result was a scrambled figure where the hand,
 * bow and arrow could not be told apart. Bending someone else's rig blind is a
 * bad trade: the motion it buys is small, and when it goes wrong it destroys
 * the silhouette, which is the one thing the player actually reads. So the
 * character mesh keeps its rest pose and the readable motion lives in:
 *
 *   aim      the bow tilts to the elevation being dialled
 *   draw     the bow pushes out and up as the string is pulled, torso leans back
 *   release  the bow snaps back toward the body, then settles
 *   knocked  the archer falls backwards, lies a beat, then gets up in two
 *            stages the way a person does — up onto a knee, then to their feet
 *
 * Everything hangs off `facingGroup`, inside which local +z is always
 * "down-range".
 */

import * as THREE from 'three';

import { instantiate } from './models';
import type { ModelKey } from './models';

/** Bow position at rest and at full draw, relative to the archer's feet. */
const BOW_REST = new THREE.Vector3(0.24, 1.16, 0.26);
const BOW_DRAWN = new THREE.Vector3(0.28, 1.4, 0.52);

const FALL_SECONDS = 0.3;
const DOWN_SECONDS = 0.5;
const KNEE_SECONDS = 0.32;
const STAND_SECONDS = 0.5;
const KNOCKED_TOTAL = FALL_SECONDS + DOWN_SECONDS + KNEE_SECONDS + STAND_SECONDS;

/** How far over the archer goes when flat out, in radians. */
const FLAT_ANGLE = 1.5;
/** Half-way pose while pushing back up onto a knee. */
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
  private readonly bowPivot = new THREE.Group();
  private readonly bodyPivot = new THREE.Group();

  private character: THREE.Object3D | null = null;

  private drawAmount = 0;
  private smoothedDraw = 0;
  private pitch = 0.2;
  private flashUntil = 0;
  private wasFlashing = false;
  private recoil = 0;
  private knockedFor = -1;
  private breathePhase = Math.random() * Math.PI * 2;

  constructor(options: ArcherVisualOptions) {
    this.facingGroup.rotation.y = options.facing === 1 ? 0 : Math.PI;
    this.group.add(this.facingGroup);
    this.facingGroup.add(this.bodyPivot);

    this.bowPivot.position.copy(BOW_REST);
    this.facingGroup.add(this.bowPivot);
  }

  async load(options: ArcherVisualOptions): Promise<void> {
    // No separate arrow: the bow mesh is modelled with one already nocked.
    const [character, bow, quiver] = await Promise.all([
      instantiate(options.model),
      instantiate('bow'),
      instantiate('quiver'),
    ]);

    this.character = character;
    this.bodyPivot.add(character);
    if (options.tint !== undefined) this.applyTint(character, options.tint);

    this.bowPivot.add(bow);

    quiver.position.set(-0.22, 0.95, -0.16);
    quiver.rotation.set(0.22, 0, 0.32);
    this.bodyPivot.add(quiver);
  }

  /**
   * Clone materials before tinting so the two archers stay independent, and
   * keep the blend light — a heavy tint flattens the texture into a blob and
   * the bow stops standing out from the body.
   */
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

  /**
   * Body angle through a knockdown, in radians of backward lean.
   *
   * Shaped like a person rather than a hinge: the fall accelerates and
   * overshoots as the body slaps down, there is a beat on the ground, then the
   * recovery comes in two pushes — up onto a knee, a moment to gather, and up
   * onto the feet.
   */
  private knockdownAngle(elapsed: number): number {
    if (elapsed < FALL_SECONDS) {
      const t = elapsed / FALL_SECONDS;
      // Accelerate over, then a little overshoot as the shoulders land.
      return FLAT_ANGLE * (t * t) * (1 + 0.12 * Math.sin(Math.PI * t));
    }

    const afterFall = elapsed - FALL_SECONDS;
    if (afterFall < DOWN_SECONDS) {
      // Settle out of the overshoot and lie still.
      const t = afterFall / DOWN_SECONDS;
      return FLAT_ANGLE * (1 + 0.06 * Math.cos(t * Math.PI * 3) * (1 - t));
    }

    const afterDown = afterFall - DOWN_SECONDS;
    if (afterDown < KNEE_SECONDS) {
      // First push: shoulders come up, hips still down.
      const t = afterDown / KNEE_SECONDS;
      const eased = t * t * (3 - 2 * t);
      return FLAT_ANGLE + (KNEE_ANGLE - FLAT_ANGLE) * eased;
    }

    // Second push: onto the feet, slowing as they straighten up.
    const t = Math.min(1, (afterDown - KNEE_SECONDS) / STAND_SECONDS);
    const eased = 1 - (1 - t) * (1 - t);
    return KNEE_ANGLE * (1 - eased);
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

    const angle = this.knockedFor >= 0 ? this.knockdownAngle(this.knockedFor) : 0;
    const down = Math.min(1, angle / FLAT_ANGLE);

    // Root: rotate about the feet, and sink as the body goes over.
    this.facingGroup.rotation.x = -angle;
    this.facingGroup.position.y = -down * 0.1;

    if (this.recoil > 0) this.recoil = Math.max(0, this.recoil - dt * 5.5);

    // Bow: rides from the rest carry to the drawn, extended position, tilts to
    // the elevation, and kicks back toward the body on release.
    const extend = this.smoothedDraw * (1 - down);
    const kick = this.recoil * 0.16;
    this.bowPivot.position.set(
      THREE.MathUtils.lerp(BOW_REST.x, BOW_DRAWN.x, extend),
      THREE.MathUtils.lerp(BOW_REST.y, BOW_DRAWN.y, extend) - down * 0.35,
      THREE.MathUtils.lerp(BOW_REST.z, BOW_DRAWN.z, extend) - kick,
    );
    // Held low and level until the shot is being lined up, then swung onto the
    // aim line — so raising the elevation is visible on the bow itself.
    this.bowPivot.rotation.x = -this.pitch * (0.35 + 0.65 * extend);

    // Torso: leans back into the draw, breathes while idle.
    const settled = (1 - this.smoothedDraw * 0.8) * (1 - down);
    this.bodyPivot.rotation.x = -extend * 0.13 + Math.sin(this.breathePhase) * 0.012 * settled;

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
