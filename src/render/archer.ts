/**
 * One archer: the generated character mesh plus a bow on an aim pivot.
 *
 * The character never moves — it stands on its mound and swings the bow — so
 * nothing here needs a skeleton. Everything hangs off `facingGroup`, inside
 * which local +z always means "down-range", so pitch and yaw can be applied
 * without caring which end of the range this archer is standing at.
 *
 * Health is shown in the HUD, not on floating plates, matching the game's
 * corner bars.
 */

import * as THREE from 'three';

import { instantiate } from './models';
import type { ModelKey } from './models';

/** The generated characters face +z, so seat 0 needs no correction. */
/** Bow hand: out to the side and forward at arm's length, not on the chest. */
const BOW_HAND = new THREE.Vector3(0.26, 1.34, 0.44);

export interface ArcherVisualOptions {
  model: Extract<ModelKey, 'archer_a' | 'archer_b'>;
  /** +1 shoots toward +z, -1 toward -z. */
  facing: 1 | -1;
}

export class ArcherRig {
  readonly group = new THREE.Group();

  private readonly facingGroup = new THREE.Group();
  private readonly aimPivot = new THREE.Group();
  private readonly bodyPivot = new THREE.Group();

  private character: THREE.Object3D | null = null;
  private nockedArrow: THREE.Object3D | null = null;

  private drawAmount = 0;
  private pitch = 0.2;
  private yaw = 0;
  private flashUntil = 0;
  private wasFlashing = false;
  private recoil = 0;

  constructor(options: ArcherVisualOptions) {
    this.facingGroup.rotation.y = options.facing === 1 ? 0 : Math.PI;
    this.group.add(this.facingGroup);

    this.facingGroup.add(this.bodyPivot);

    this.aimPivot.position.copy(BOW_HAND);
    this.facingGroup.add(this.aimPivot);
  }

  async load(options: ArcherVisualOptions): Promise<void> {
    const [character, bow, arrow, quiver] = await Promise.all([
      instantiate(options.model),
      instantiate('bow'),
      instantiate('arrow'),
      instantiate('quiver'),
    ]);

    this.character = character;
    this.bodyPivot.add(character);

    quiver.position.set(-0.2, 0.95, -0.14);
    quiver.rotation.set(0.22, 0, 0.3);
    this.bodyPivot.add(quiver);

    // The bow is modelled upright; turn it so the limbs stand across the line
    // of fire and the string faces the archer.
    bow.rotation.set(0, Math.PI / 2, 0);
    this.aimPivot.add(bow);

    // models.ts canonicalises elongated meshes to point along +z, which is
    // already down-range inside `facingGroup` — no correction needed.
    this.nockedArrow = arrow;
    this.aimPivot.add(arrow);
  }

  /** Elevation in radians — the number the gauge shows. */
  setAim(pitch: number, yaw: number): void {
    this.pitch = pitch;
    this.yaw = yaw;
  }

  setDraw(amount: number): void {
    this.drawAmount = Math.max(0, Math.min(1, amount));
  }

  release(): void {
    this.drawAmount = 0;
    this.recoil = 1;
    if (this.nockedArrow) this.nockedArrow.visible = false;
  }

  nock(): void {
    if (this.nockedArrow) this.nockedArrow.visible = true;
  }

  flashHit(): void {
    this.flashUntil = performance.now() + 340;
  }

  update(nowMs: number): void {
    // Local +z is down-range: a positive pitch tips the bow up, which is a
    // negative rotation about x.
    this.aimPivot.rotation.set(-this.pitch, this.yaw, 0);
    // Drawing leans the archer back into the shot.
    this.bodyPivot.rotation.x = -this.drawAmount * 0.05;
    this.bodyPivot.rotation.y = this.yaw * 0.7;

    if (this.recoil > 0) {
      this.recoil = Math.max(0, this.recoil - 0.09);
      this.aimPivot.position.z = BOW_HAND.z - this.recoil * 0.1;
    }

    if (this.nockedArrow) {
      // Slide the nocked arrow back along the shaft as the bow is drawn.
      this.nockedArrow.position.set(0, 0, -this.drawAmount * 0.36);
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
