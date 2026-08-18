/**
 * One archer.
 *
 * The character mesh is used exactly as generated, and no bone is ever touched.
 * That is the conclusion of three attempts at articulating it:
 *
 *   - Full-arm IK against the auto-rigged skeleton scrambled the figure.
 *   - A single bounded rotation on an upper arm dragged the head into a spike,
 *     because the auto-rigger weights head vertices onto arm bones.
 *   - The rigged mesh itself is re-posed into a T-pose by the rigger, so it
 *     stands like a mannequin with both arms straight out. The un-rigged
 *     meshes are the ones that actually stand like archers.
 *
 * So the skeleton is not used at all. Every animation lives on groups this code
 * owns, where it cannot deform the silhouette — the one thing a player reads:
 *
 *   aim      the bow tilts onto the aim line
 *   draw     the bow rides out from a low carry to full extension, a procedural
 *            bowstring bends back into a deepening V, and the torso leans in
 *   release  the bow kicks back toward the body, then settles
 *   knocked  the archer falls backwards, lies a beat, then gets up in two
 *            pushes — onto a knee, gather, onto the feet
 *
 * Everything hangs off `facingGroup`, inside which local +z is always
 * "down-range".
 */

import * as THREE from 'three';

import { instantiate } from './models';
import type { ModelKey } from './models';

/**
 * Bow carry position, relative to the archer's feet: out to the bow side and
 * clear in front of the chest, so it never buries itself in the torso.
 */
const BOW_REST = new THREE.Vector3(0.3, 1.22, 0.52);
/** Where the bow sits at full draw — pushed out and lifted. */
const BOW_DRAWN = new THREE.Vector3(0.33, 1.38, 0.66);

/** How far the nock travels back at full draw, in metres. */
const DRAW_TRAVEL = 0.34;

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
}

export class ArcherRig {
  readonly group = new THREE.Group();

  private readonly facingGroup = new THREE.Group();
  private readonly bowPivot = new THREE.Group();
  private readonly bodyPivot = new THREE.Group();

  private character: THREE.Object3D | null = null;
  private bow: THREE.Object3D | null = null;

  private stringLine: THREE.Line | null = null;
  /** Limb tips in the bow's OWN frame, measured before it is parented. */
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
    this.bow = bow;
    this.bodyPivot.add(character);

    // Measure the bow BEFORE parenting it. Box3.setFromObject returns WORLD
    // bounds, so measuring afterwards yields the bow's position in the scene
    // and the string ends up drawn as a streak across the sky.
    this.measureLimbs(bow);
    this.bowPivot.add(bow);
    this.buildString();

    quiver.position.set(-0.22, 0.95, -0.16);
    quiver.rotation.set(0.22, 0, 0.32);
    this.bodyPivot.add(quiver);
  }

  private measureLimbs(bow: THREE.Object3D): void {
    bow.updateWorldMatrix(false, true);
    const box = new THREE.Box3().setFromObject(bow);
    const size = new THREE.Vector3();
    const centre = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(centre);
    // The bow is normalised upright and centred, so the tips sit on its own y.
    this.limbTop.set(centre.x, centre.y + size.y * 0.45, centre.z);
    this.limbBottom.set(centre.x, centre.y - size.y * 0.45, centre.z);
  }

  /**
   * A three-point line standing in for the bowstring. The modelled string on
   * the bow mesh is straight and cannot animate; this one bends back to the
   * nock, which is what makes a draw read as a draw.
   */
  private buildString(): void {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    const material = new THREE.LineBasicMaterial({
      color: 0xf6f2e4,
      transparent: true,
      opacity: 0.95,
    });
    const line = new THREE.Line(geometry, material);
    line.frustumCulled = false;
    line.visible = false;
    this.stringLine = line;
    this.group.add(line);
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

  /**
   * Rebuild the bowstring.
   *
   * The line lives under `group`, so every point must be converted out of
   * world space before it is written — writing world coordinates into a child
   * applies the parent transform a second time and throws the string across
   * the scene.
   */
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
    this.group.worldToLocal(this.scratch);
    positions.setXYZ(0, this.scratch.x, this.scratch.y, this.scratch.z);

    // Nock: the bow's middle, pulled back along the archer's own backward
    // direction so the string bends into a V as the shot is drawn.
    this.scratchB.set(0, 0, 0).applyMatrix4(bow.matrixWorld);
    this.facingGroup.worldToLocal(this.scratchB);
    this.scratchB.z -= draw * DRAW_TRAVEL;
    this.facingGroup.localToWorld(this.scratchB);
    this.group.worldToLocal(this.scratchB);
    positions.setXYZ(1, this.scratchB.x, this.scratchB.y, this.scratchB.z);

    this.scratch.copy(this.limbBottom).applyMatrix4(bow.matrixWorld);
    this.group.worldToLocal(this.scratch);
    positions.setXYZ(2, this.scratch.x, this.scratch.y, this.scratch.z);

    positions.needsUpdate = true;
    line.geometry.computeBoundingSphere();
    line.visible = true;
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

    // Bow: rides from the low carry out to full extension, drops with the body
    // when knocked over, and kicks back toward the chest on release.
    this.bowPivot.position.set(
      THREE.MathUtils.lerp(BOW_REST.x, BOW_DRAWN.x, draw),
      THREE.MathUtils.lerp(BOW_REST.y, BOW_DRAWN.y, draw) - down * 0.35,
      THREE.MathUtils.lerp(BOW_REST.z, BOW_DRAWN.z, draw) - this.recoil * 0.13,
    );
    // Held closer to level at rest, swung fully onto the aim line as the shot
    // is drawn — so raising the elevation is visible on the bow itself.
    this.bowPivot.rotation.x = -this.pitch * (0.4 + 0.6 * draw) * (1 - down);

    // The string is rebuilt last, once everything it hangs between has moved.
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
