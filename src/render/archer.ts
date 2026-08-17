/**
 * One archer: the generated character mesh plus a bow on a pivot.
 *
 * The original game's archers never move — they only swing the bow up and down
 * — so nothing here needs a skeleton. The character is a static mesh turned to
 * face the opponent, the bow hangs off a pivot at the bow hand, and drawing is
 * the nocked arrow sliding back with a small torso lean. That is exactly the
 * amount of animation the game reads as, and it keeps the assets cheap.
 */

import * as THREE from 'three';

import { instantiate } from './models';
import type { ModelKey } from './models';
import type { ArcherStats } from '../sim';

/** Generated characters face +Z; turn them to look along ±X at each other. */
const FACING_YAW = Math.PI / 2;

const BOW_PIVOT = new THREE.Vector3(0.26, 1.3, 0.16);
const NAME_PLATE_HEIGHT = 2.25;

export interface ArcherVisualOptions {
  model: Extract<ModelKey, 'archer_a' | 'archer_b'>;
  facing: 1 | -1;
  name: string;
  accent: number;
}

export class ArcherRig {
  readonly group = new THREE.Group();

  private readonly bowPivot = new THREE.Group();
  private readonly bodyPivot = new THREE.Group();
  private readonly facing: 1 | -1;
  private readonly accent: number;

  private nockedArrow: THREE.Object3D | null = null;
  private plate: THREE.Sprite | null = null;
  private plateTexture: THREE.CanvasTexture | null = null;
  private plateCanvas: HTMLCanvasElement | null = null;

  private drawAmount = 0;
  private aimAngle = 0.5;
  private flashUntil = 0;
  private recoil = 0;
  private name: string;

  constructor(options: ArcherVisualOptions) {
    this.facing = options.facing;
    this.accent = options.accent;
    this.name = options.name;

    this.bodyPivot.rotation.y = FACING_YAW * options.facing;
    this.group.add(this.bodyPivot);

    this.bowPivot.position.set(BOW_PIVOT.x * options.facing, BOW_PIVOT.y, BOW_PIVOT.z);
    this.group.add(this.bowPivot);
  }

  async load(options: ArcherVisualOptions): Promise<void> {
    const [character, bow, arrow, quiver] = await Promise.all([
      instantiate(options.model),
      instantiate('bow'),
      instantiate('arrow'),
      instantiate('quiver').catch(() => null),
    ]);

    this.bodyPivot.add(character);

    if (quiver) {
      quiver.position.set(-0.16 * this.facing, 0.95, -0.16);
      quiver.rotation.set(0.24, FACING_YAW * this.facing, 0.3 * this.facing);
      this.bodyPivot.add(quiver);
    }

    // The bow model is normalised upright; lay it into the hand and mirror it
    // for the archer on the right so both draw toward the centre.
    bow.rotation.set(0, this.facing === 1 ? 0 : Math.PI, 0);
    this.bowPivot.add(bow);

    arrow.rotation.set(0, 0, this.facing === 1 ? 0 : Math.PI);
    this.nockedArrow = arrow;
    this.bowPivot.add(arrow);

    this.plate = this.createPlate();
    this.plate.position.set(0, NAME_PLATE_HEIGHT, 0);
    this.group.add(this.plate);
  }

  private createPlate(): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    this.plateCanvas = canvas;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    this.plateTexture = texture;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }),
    );
    sprite.scale.set(2.1, 0.52, 1);
    sprite.renderOrder = 10;
    return sprite;
  }

  /** Health bar + name, drawn into the sprite's canvas. */
  setHealth(health: number, stats: ArcherStats): void {
    const canvas = this.plateCanvas;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !this.plateTexture) return;

    const ratio = Math.max(0, Math.min(1, health / stats.maxHealth));
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.font = '600 22px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // A dark halo keeps the name legible against both bright sky and dark stone.
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0,0,0,0.72)';
    ctx.strokeText(this.name, canvas.width / 2, 16);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(this.name, canvas.width / 2, 16);

    const barX = 24;
    const barY = 38;
    const barW = canvas.width - 48;
    const barH = 14;

    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    ctx.fillRect(barX - 2, barY - 2, barW + 4, barH + 4);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(barX, barY, barW, barH);

    const colour = ratio > 0.5 ? '#4ade80' : ratio > 0.22 ? '#fbbf24' : '#f87171';
    ctx.fillStyle = colour;
    ctx.fillRect(barX, barY, barW * ratio, barH);

    this.plateTexture.needsUpdate = true;
  }

  setName(name: string): void {
    this.name = name;
  }

  /** Aim angle in radians, already in the shooter's own frame. */
  setAim(angle: number): void {
    this.aimAngle = angle;
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
    this.flashUntil = performance.now() + 320;
  }

  setActive(active: boolean): void {
    this.group.scale.setScalar(active ? 1.0 : 0.985);
  }

  update(nowMs: number): void {
    // The bow swings with the aim; a drawn bow also tips the torso back.
    this.bowPivot.rotation.z = this.aimAngle * this.facing * -1;
    this.bodyPivot.rotation.z = this.drawAmount * 0.06 * -this.facing;

    if (this.recoil > 0) {
      this.recoil = Math.max(0, this.recoil - 0.08);
      this.bowPivot.position.x =
        BOW_PIVOT.x * this.facing - this.recoil * 0.09 * this.facing;
    }

    if (this.nockedArrow) {
      // Slide the nocked arrow back along the bow as the shot is drawn.
      const pull = this.drawAmount * 0.34;
      this.nockedArrow.position.set(-pull * this.facing, 0, 0.05);
      this.nockedArrow.rotation.z = this.facing === 1 ? 0 : Math.PI;
    }

    const flashing = nowMs < this.flashUntil;
    this.bodyPivot.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        const standard = material as THREE.MeshStandardMaterial;
        if (!standard || !standard.emissive) continue;
        standard.emissive.setHex(flashing ? 0xff3b30 : 0x000000);
        standard.emissiveIntensity = flashing ? 0.55 : 0;
      }
    });
  }

  /** World position of the bow hand — where arrows are born. */
  muzzleWorld(target: THREE.Vector3): THREE.Vector3 {
    return this.bowPivot.getWorldPosition(target);
  }

  get accentColour(): number {
    return this.accent;
  }

  dispose(): void {
    this.plateTexture?.dispose();
    this.plate?.material.dispose();
  }
}
