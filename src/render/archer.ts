/**
 * One archer, driven by the character's own authored animation clips.
 *
 * The mesh is a CC0 rigged character that ships with a full clip set — idle,
 * a two-handed aiming pose, a shoot, a hit reaction and a death. Playing those
 * is the whole animation system: nothing here poses a bone by hand.
 *
 * That is the conclusion of three failed attempts at articulating the
 * AI-generated characters: whole-arm IK scrambled the figure, a single
 * upper-arm rotation dragged the head into a spike (head vertices were
 * weighted onto arm bones), and the auto-rigger re-posed its own output into a
 * T-pose mannequin. Generated meshes could not be animated; an authored rig
 * can, and it looks right because an animator posed it.
 *
 *   idle      standing, breathing
 *   aiming    crossfade to the aiming pose as the shot is drawn
 *   release   the shoot clip, once
 *   knocked   the death clip forward to go down, then the SAME clip in reverse
 *             to get back up — which reads as a person pushing themselves up
 *
 * The bow is parented to a wrist bone, so it follows the animated hand. Only
 * its tilt onto the aim line is driven from here.
 *
 * Everything hangs off `facingGroup`, inside which local +z is always
 * "down-range".
 */

import * as THREE from 'three';

import { animationsFor, instantiate } from './models';
import type { ModelKey } from './models';

/** Fallback bow carry for a mesh with no skeleton to hang it on. */
const BOW_REST = new THREE.Vector3(0.3, 1.22, 0.52);

/** Seconds of the death clip; the rise replays it backwards at this rate. */
const RISE_RATE = 0.85;
/** Beat spent lying on the ground between falling and getting up. */
const DOWN_SECONDS = 0.55;

type Phase = 'idle' | 'aiming' | 'shooting' | 'falling' | 'down' | 'rising';

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
  private mixer: THREE.AnimationMixer | null = null;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private phase: Phase = 'idle';
  private phaseTimer = 0;

  private bowHolder: THREE.Group | null = null;

  private drawAmount = 0;
  private smoothedDraw = 0;
  private pitch = 0.2;
  private flashUntil = 0;
  private wasFlashing = false;
  private recoil = 0;

  private readonly scratch = new THREE.Vector3();

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

    // The character comes holding a sword; this one shoots.
    character.traverse((child) => {
      if (/sword/i.test(child.name)) child.visible = false;
    });

    this.setupAnimation(character, options.model);
    this.attachBow(character, bow);

    quiver.position.set(-0.22, 0.95, -0.16);
    quiver.rotation.set(0.22, 0, 0.32);
    this.bodyPivot.add(quiver);
  }

  /**
   * Clips are named `CharacterArmature|Idle` and similar, so they are matched
   * on the suffix rather than the full string.
   */
  private setupAnimation(character: THREE.Object3D, model: ModelKey): void {
    const clips = animationsFor(model);
    if (clips.length === 0) return;

    const mixer = new THREE.AnimationMixer(character);
    this.mixer = mixer;

    const want = ['Idle', 'Idle_Gun_Pointing', 'Idle_Gun_Shoot', 'HitRecieve', 'Death'];
    for (const key of want) {
      const clip = clips.find((c) => c.name === key || c.name.endsWith(`|${key}`));
      if (!clip) continue;
      const action = mixer.clipAction(clip);
      action.enabled = true;
      this.actions.set(key, action);
    }

    this.play('Idle', 0);
  }

  private play(key: string, fade = 0.25, loop = true): THREE.AnimationAction | null {
    const action = this.actions.get(key);
    if (!action || action === this.current) return action ?? null;

    action.reset();
    action.timeScale = 1;
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    action.clampWhenFinished = !loop;
    action.fadeIn(fade);
    this.current?.fadeOut(fade);
    action.play();
    this.current = action;
    return action;
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

  /** Hang the bow off a wrist so it follows whatever the clip does. */
  private attachBow(character: THREE.Object3D, bow: THREE.Object3D): void {
    const wrist =
      this.findBone(character, 'Wrist.L') ??
      this.findBone(character, 'LeftHand') ??
      this.findBone(character, 'Wrist.R');

    if (!wrist) {
      this.bowPivot.add(bow);
      return;
    }

    const holder = new THREE.Group();
    // The wrist lives inside the scaled rig; undo that so the bow keeps the
    // size it was normalised to.
    const scale = wrist.getWorldScale(this.scratch).x;
    holder.scale.setScalar(scale > 0 ? 1 / scale : 1);
    holder.add(bow);
    wrist.add(holder);
    this.bowHolder = holder;
    this.bowPivot.visible = false;
  }

  private applyTint(root: THREE.Object3D, tint: number): void {
    const colour = new THREE.Color(tint);
    root.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const cloned = list.map((material) => {
        const copy = (material as THREE.MeshStandardMaterial).clone();
        copy.color.lerp(colour, 0.3);
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
    if (this.phase === 'falling' || this.phase === 'down' || this.phase === 'rising') return;
    this.phase = 'shooting';
    this.phaseTimer = 0;
    this.play('Idle_Gun_Shoot', 0.08, false);
  }

  nock(): void {
    // The bow carries its own arrow; nothing to show or hide.
  }

  /** Take a hit: go down with the death clip, then rise by reversing it. */
  knockDown(): void {
    this.flashUntil = performance.now() + 340;
    this.drawAmount = 0;
    this.phase = 'falling';
    this.phaseTimer = 0;
    const action = this.play('Death', 0.12, false);
    if (action) action.timeScale = 1;
  }

  get isKnockedDown(): boolean {
    return this.phase === 'falling' || this.phase === 'down' || this.phase === 'rising';
  }

  flashHit(): void {
    this.flashUntil = performance.now() + 340;
  }

  private advancePhase(dt: number): void {
    this.phaseTimer += dt;
    const death = this.actions.get('Death');

    switch (this.phase) {
      case 'falling': {
        const length = death?.getClip().duration ?? 1;
        if (this.phaseTimer >= length) {
          this.phase = 'down';
          this.phaseTimer = 0;
        }
        break;
      }
      case 'down': {
        if (this.phaseTimer < DOWN_SECONDS) break;
        this.phase = 'rising';
        this.phaseTimer = 0;
        // Rewind the fall: the same motion backwards reads as pushing up.
        if (death) {
          death.paused = false;
          death.timeScale = -RISE_RATE;
          death.time = death.getClip().duration;
          death.play();
        }
        break;
      }
      case 'rising': {
        const length = (death?.getClip().duration ?? 1) / RISE_RATE;
        if (this.phaseTimer >= length) {
          this.phase = 'idle';
          this.phaseTimer = 0;
          this.current = null;
          this.play('Idle', 0.2);
        }
        break;
      }
      case 'shooting': {
        const shot = this.actions.get('Idle_Gun_Shoot');
        if (this.phaseTimer >= (shot?.getClip().duration ?? 0.7)) {
          this.phase = 'idle';
          this.phaseTimer = 0;
        }
        break;
      }
      default: {
        // Drawing the bow holds the aiming pose; otherwise stand easy.
        const wantAim = this.smoothedDraw > 0.05;
        if (wantAim && this.phase !== 'aiming') {
          this.phase = 'aiming';
          this.play('Idle_Gun_Pointing', 0.28);
        } else if (!wantAim && this.phase === 'aiming') {
          this.phase = 'idle';
          this.play('Idle', 0.35);
        }
        break;
      }
    }
  }

  update(nowMs: number, deltaSeconds = 1 / 60): void {
    const dt = Math.min(0.1, Math.max(0.001, deltaSeconds));

    this.smoothedDraw += (this.drawAmount - this.smoothedDraw) * Math.min(1, dt * 14);
    if (this.recoil > 0) this.recoil = Math.max(0, this.recoil - dt * 5.5);

    this.advancePhase(dt);
    this.mixer?.update(dt);

    // Bow: follows the animated hand; only the aim tilt and kick come from here.
    const target = this.bowHolder ?? this.bowPivot;
    const down = this.isKnockedDown ? 1 : 0;
    target.rotation.x = -this.pitch * 0.75 * (1 - down);
    if (this.bowHolder) {
      this.bowHolder.position.z = -this.recoil * 0.1;
    } else {
      this.bowPivot.position.z = BOW_REST.z - this.recoil * 0.12;
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
    this.mixer?.stopAllAction();
    this.group.removeFromParent();
  }
}
