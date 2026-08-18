/**
 * One archer, driven by real Mixamo archery animation.
 *
 * The important idea here is that the draw is SCRUBBED, not played: the
 * "Standing Draw Arrow" clip is held paused and its time is set from how far
 * the player has pulled. Nocking, raising the bow and pulling the string all
 * happen under the player's thumb, and letting go runs it back down. A clip
 * played at its own pace could never do that — it would be a cutscene next to
 * the input rather than a response to it.
 *
 *   rest      the draw clip at t = 0
 *   drawing   the draw clip scrubbed to the current pull
 *   held      crossfade to the overdraw loop once fully drawn, so a held shot
 *             breathes instead of freezing
 *   loose     the draw clip scrubbed rapidly back to 0
 *   knocked   the death clip forward to go down, then the SAME clip reversed to
 *             get back up, which reads as pushing yourself off the ground
 *
 * All three clips share one 65-bone Mixamo skeleton, so the two that ship
 * without a character still bind to this one by node name.
 *
 * The bow takes its position from the animated bow hand but keeps an
 * orientation set here — upright and square to the lane. Inheriting the hand's
 * rotation left it hanging off the wrist at an angle.
 *
 * Everything hangs off `facingGroup`, inside which local +z is always
 * "down-range".
 */

import * as THREE from 'three';

import { animationsFor, instantiate, loadClips } from './models';
import type { ModelKey } from './models';

/** Fallback bow carry for a mesh with no skeleton to hang it on. */
const BOW_REST = new THREE.Vector3(0.3, 1.22, 0.52);

/** Seconds the loose takes to run the draw clip back to rest. */
const LOOSE_SECONDS = 0.16;
/** Beat spent lying on the ground between falling and getting up. */
const DOWN_SECONDS = 0.6;
/** The rise replays the death clip backwards at this rate. */
const RISE_RATE = 0.9;

type Phase = 'ready' | 'down' | 'rising';

export interface ArcherVisualOptions {
  model: ModelKey;
  /** +1 shoots toward +z, -1 toward -z. */
  facing: 1 | -1;
  /** Applied to the character, which ships untextured. */
  tint?: number;
}

export class ArcherRig {
  readonly group = new THREE.Group();

  private readonly facingGroup = new THREE.Group();
  private readonly bowPivot = new THREE.Group();
  private readonly bodyPivot = new THREE.Group();

  private character: THREE.Object3D | null = null;
  private mixer: THREE.AnimationMixer | null = null;

  private drawAction: THREE.AnimationAction | null = null;
  private aimAction: THREE.AnimationAction | null = null;
  private deathAction: THREE.AnimationAction | null = null;

  private phase: Phase = 'ready';
  private phaseTimer = 0;
  /** 0 at rest, 1 fully drawn — what the draw clip is scrubbed to. */
  private scrub = 0;
  private aimBlend = 0;
  private loosing = false;

  private bowHand: THREE.Bone | null = null;

  private drawAmount = 0;
  private pitch = 0.2;
  private flashUntil = 0;
  private wasFlashing = false;
  private recoil = 0;

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
    const [character, bow, quiver, aimClips, deathClips] = await Promise.all([
      instantiate(options.model),
      instantiate('bow'),
      instantiate('quiver'),
      loadClips('anim_aim'),
      loadClips('anim_death'),
    ]);

    this.character = character;
    this.bodyPivot.add(character);
    if (options.tint !== undefined) this.applyTint(character, options.tint);

    this.setupAnimation(character, options.model, aimClips, deathClips);
    this.attachBow(character, bow);
    this.attachQuiver(character, quiver);
  }

  private setupAnimation(
    character: THREE.Object3D,
    model: ModelKey,
    aimClips: THREE.AnimationClip[],
    deathClips: THREE.AnimationClip[],
  ): void {
    const own = animationsFor(model);
    if (own.length === 0) return;

    const mixer = new THREE.AnimationMixer(character);
    this.mixer = mixer;

    const draw = own[0];
    this.drawAction = mixer.clipAction(draw);
    this.drawAction.play();
    // Held still and driven by hand — see the note at the top of the file.
    this.drawAction.paused = true;
    this.drawAction.time = 0;
    this.drawAction.setEffectiveWeight(1);

    if (aimClips[0]) {
      this.aimAction = mixer.clipAction(aimClips[0]);
      this.aimAction.play();
      this.aimAction.setEffectiveWeight(0);
    }

    if (deathClips[0]) {
      this.deathAction = mixer.clipAction(deathClips[0]);
      this.deathAction.setLoop(THREE.LoopOnce, 1);
      this.deathAction.clampWhenFinished = true;
      this.deathAction.setEffectiveWeight(0);
    }
  }

  /**
   * Find a bone by name, ignoring punctuation.
   *
   * three sanitises node names on import, so "mixamorig:LeftHand" arrives as
   * "mixamorigLeftHand". Matching raw names silently found nothing, which is
   * how the bow once ended up parented to a fallback pivot and floating beside
   * the body instead of sitting in the hand.
   */
  private findBone(root: THREE.Object3D, ...names: string[]): THREE.Bone | null {
    const key = (value: string): string => value.replace(/[^a-z0-9]/gi, '').toLowerCase();
    const wanted = names.map(key);
    let found: THREE.Bone | null = null;
    root.traverse((child) => {
      if (found || !(child as THREE.Bone).isBone) return;
      if (wanted.includes(key(child.name))) found = child as THREE.Bone;
    });
    return found;
  }

  /**
   * The bow follows the animated bow hand but keeps an orientation set here.
   *
   * Which hand is measured rather than assumed: the draw clip is sampled
   * part-way through and whichever wrist ends up further down-range is the one
   * supporting the bow.
   */
  private attachBow(character: THREE.Object3D, bow: THREE.Object3D): void {
    this.bowPivot.add(bow);

    if (this.drawAction && this.mixer) {
      this.drawAction.time = this.drawAction.getClip().duration * 0.75;
      this.mixer.update(0);
    }
    character.updateWorldMatrix(true, true);

    const left = this.findBone(character, 'mixamorig:LeftHand', 'LeftHand', 'Wrist.L');
    const right = this.findBone(character, 'mixamorig:RightHand', 'RightHand', 'Wrist.R');

    if (left && right) {
      const leftZ = this.facingGroup.worldToLocal(left.getWorldPosition(this.scratch)).z;
      const rightZ = this.facingGroup.worldToLocal(right.getWorldPosition(this.scratchB)).z;
      this.bowHand = leftZ >= rightZ ? left : right;
    } else {
      this.bowHand = left ?? right;
    }

    if (this.drawAction) this.drawAction.time = 0;
    this.mixer?.update(0);
  }

  /** Strap the quiver to the back so it rides the body, falls included. */
  private attachQuiver(character: THREE.Object3D, quiver: THREE.Object3D): void {
    const spine = this.findBone(
      character,
      'mixamorig:Spine2',
      'mixamorig:Spine1',
      'Torso',
      'Chest',
    );
    if (!spine) {
      quiver.position.set(-0.22, 0.95, -0.16);
      quiver.rotation.set(0.22, 0, 0.32);
      this.bodyPivot.add(quiver);
      return;
    }
    const holder = new THREE.Group();
    const scale = spine.getWorldScale(this.scratch).x;
    holder.scale.setScalar(scale > 0 ? 1 / scale : 1);
    holder.position.set(-0.14, 0.06, -0.14);
    holder.rotation.set(0.25, 0, 0.32);
    holder.add(quiver);
    spine.add(holder);
  }

  /** The Mixamo exports carry no materials, so the colour is set here. */
  private applyTint(root: THREE.Object3D, tint: number): void {
    const colour = new THREE.Color(tint);
    root.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const cloned = list.map((material) => {
        const copy = (material as THREE.MeshStandardMaterial).clone();
        copy.color.copy(colour);
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
    if (this.phase === 'ready') this.loosing = true;
  }

  nock(): void {
    // The bow carries its own arrow; nothing to show or hide.
  }

  /** Take a hit: go down with the death clip, then rise by reversing it. */
  knockDown(): void {
    this.flashUntil = performance.now() + 340;
    this.drawAmount = 0;
    this.scrub = 0;
    this.loosing = false;
    this.phase = 'down';
    this.phaseTimer = 0;

    const death = this.deathAction;
    if (!death) return;
    death.reset();
    death.timeScale = 1;
    death.setEffectiveWeight(1);
    death.play();
    this.drawAction?.setEffectiveWeight(0);
    this.aimAction?.setEffectiveWeight(0);
  }

  get isKnockedDown(): boolean {
    return this.phase !== 'ready';
  }

  flashHit(): void {
    this.flashUntil = performance.now() + 340;
  }

  private advance(dt: number): void {
    const death = this.deathAction;

    if (this.phase === 'down') {
      this.phaseTimer += dt;
      const length = (death?.getClip().duration ?? 1) + DOWN_SECONDS;
      if (this.phaseTimer < length) return;
      this.phase = 'rising';
      this.phaseTimer = 0;
      if (death) {
        // Rewind the fall: the same motion backwards reads as getting up.
        death.paused = false;
        death.timeScale = -RISE_RATE;
        death.time = death.getClip().duration;
        death.play();
      }
      return;
    }

    if (this.phase === 'rising') {
      this.phaseTimer += dt;
      const length = (death?.getClip().duration ?? 1) / RISE_RATE;
      if (this.phaseTimer < length) return;
      this.phase = 'ready';
      this.phaseTimer = 0;
      death?.setEffectiveWeight(0);
      death?.stop();
      return;
    }

    // Ready: the draw clip tracks the player's pull. Letting go runs it back
    // down fast, which is the loose.
    const target = this.loosing ? 0 : this.drawAmount;
    const rate = this.loosing ? 1 / LOOSE_SECONDS : 6;
    const step = rate * dt;
    if (Math.abs(target - this.scrub) <= step) {
      this.scrub = target;
      if (this.loosing) this.loosing = false;
    } else {
      this.scrub += Math.sign(target - this.scrub) * step;
    }

    // Fully drawn, the overdraw loop takes over so a held shot still breathes.
    const wantAim = this.scrub > 0.97 && !this.loosing ? 1 : 0;
    this.aimBlend += (wantAim - this.aimBlend) * Math.min(1, dt * 5);
  }

  update(nowMs: number, deltaSeconds = 1 / 60): void {
    const dt = Math.min(0.1, Math.max(0.001, deltaSeconds));
    if (this.recoil > 0) this.recoil = Math.max(0, this.recoil - dt * 5.5);

    this.advance(dt);

    if (this.phase === 'ready') {
      const draw = this.drawAction;
      if (draw) {
        draw.paused = true;
        draw.time = this.scrub * draw.getClip().duration;
        draw.setEffectiveWeight(1 - this.aimBlend);
      }
      this.aimAction?.setEffectiveWeight(this.aimBlend);
    }

    this.mixer?.update(dt);
    // Bones moved; refresh world matrices before the bow reads the hand.
    this.character?.updateWorldMatrix(true, true);

    // Bow: position from the animated hand, orientation from here.
    if (this.bowHand) {
      this.bowHand.getWorldPosition(this.scratch);
      this.facingGroup.worldToLocal(this.scratch);
      this.bowPivot.position.copy(this.scratch);
      this.bowPivot.position.z -= this.recoil * 0.1;
    } else {
      this.bowPivot.position.copy(BOW_REST);
      this.bowPivot.position.z = BOW_REST.z - this.recoil * 0.12;
    }
    this.bowPivot.rotation.x = -this.pitch * 0.75;
    this.bowPivot.visible = this.phase === 'ready';

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
    this.mixer?.stopAllAction();
    this.group.removeFromParent();
  }
}
