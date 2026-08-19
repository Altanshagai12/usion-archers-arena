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
 * The nocked arrow is a separate mesh riding the DRAWING hand, so it travels
 * back with the string as the shot is pulled and springs away on release. The
 * bow's own modelled string is hidden: it is rigid geometry that cannot move,
 * which is exactly what made the draw look frozen.
 *
 * Everything hangs off `facingGroup`, inside which local +z is always
 * "down-range".
 */

import * as THREE from 'three';

import { animationsFor, instantiate, loadClips } from './models';
import type { ModelKey } from './models';
import { dressCharacter, outfitFor } from './outfit';

/** Fallback bow carry for a mesh with no skeleton to hang it on. */
const BOW_REST = new THREE.Vector3(0.3, 1.22, 0.52);

/**
 * How much of the shot's elevation each spine bone carries.
 *
 * Aiming up and down has to move the BOW, not just the arrow — an archer
 * raises the whole bow arm. Bending the spine does that with everything
 * attached: the bow is skinned to one hand, the string bone follows the other,
 * and the nocked arrow lies on the line between them, so all of it elevates
 * together. Split over two bones so the torso curves instead of hinging.
 */
const SPINE_AIM_SHARE: Array<[string, number]> = [
  ['mixamorig:Spine1', 0.45],
  ['mixamorig:Spine2', 0.45],
];

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
  /** The tunic colour — the character ships untextured and undressed. */
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
  /** Set by the hit that ended the match — this archer does not get back up. */
  private defeated = false;
  /** 0 at rest, 1 fully drawn — what the draw clip is scrubbed to. */
  private scrub = 0;
  private aimBlend = 0;
  private loosing = false;

  /** Spine bones that carry the aim, with the share of it each takes. */
  private aimBones: Array<{ bone: THREE.Bone; share: number }> = [];
  private readonly pitchAxis = new THREE.Vector3();
  private readonly parentSpace = new THREE.Matrix4();
  private readonly tilt = new THREE.Quaternion();

  private bowHand: THREE.Bone | null = null;
  /** The hand that pulls; the bowstring is anchored to it. */
  private stringHand: THREE.Bone | null = null;

  private bow: THREE.Object3D | null = null;
  /** The character's own string bone, when it has one. See `load`. */
  private stringBone: THREE.Bone | null = null;
  private arrow: THREE.Object3D | null = null;
  private readonly arrowPivot = new THREE.Group();
  /** Nock to arrow centre, measured off the mesh. */
  private arrowReach = 0.39;
  /** True between loosing a shot and drawing the next one. */
  private arrowGone = false;
  private stringLine: THREE.Line | null = null;
  /** Limb tips in the bow's OWN frame, measured before it is parented. */
  private readonly limbTop = new THREE.Vector3();
  private readonly limbBottom = new THREE.Vector3();

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
    this.facingGroup.add(this.arrowPivot);
  }

  async load(options: ArcherVisualOptions): Promise<void> {
    const [character, aimClips, deathClips] = await Promise.all([
      instantiate(options.model),
      loadClips('anim_aim'),
      loadClips('anim_death'),
    ]);

    this.character = character;
    this.bodyPivot.add(character);
    dressCharacter(character, outfitFor(options.tint ?? 0x8a8f99));
    this.setupAnimation(character, options.model, aimClips, deathClips);
    this.findHands(character);
    this.aimBones = SPINE_AIM_SHARE.map(([name, share]) => ({
      bone: this.findBone(character, name, name.split(':')[1]),
      share,
    })).filter((entry): entry is { bone: THREE.Bone; share: number } => entry.bone !== null);

    const ownBow = this.partOf(character, /^bow/i);
    const ownArrow = this.partOf(character, /^arrow/i);

    // Her own arrow hangs off a bone parented to the HIPS that no clip touches,
    // so it sits frozen by her waist through the entire draw. Hidden, and the
    // game's own nocked arrow — which rides the drawing hand — takes its place.
    if (ownArrow) ownArrow.visible = false;
    this.attachArrow(await instantiate('arrow'));

    if (ownBow) {
      // Her bow is skinned to her hand and carries its own string, 18 vertices
      // of which are weighted to a bone sitting exactly mid-limb: the nocking
      // point. No clip drives it either, so the string stayed rigid — the
      // frame loop pulls that bone to the drawing hand instead.
      this.stringBone = this.findBone(character, 'mixamorig:Left_arch2', 'Left_arch2');
      return;
    }

    const [bow, quiver] = await Promise.all([instantiate('bow'), instantiate('quiver')]);
    this.attachBow(character, bow);
    this.attachQuiver(character, quiver);
  }

  /**
   * A part of the character, found by MATERIAL name.
   *
   * The exporter's node names did not line up with the geometry they held,
   * while the materials ("Bow_MAT", "Arrow_MAT", "Body_MAT1") named their
   * parts exactly.
   */
  private partOf(character: THREE.Object3D, pattern: RegExp): THREE.Mesh | null {
    let found: THREE.Mesh | null = null;
    character.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (found || !mesh.isMesh) return;
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (list.some((material) => pattern.test((material as THREE.Material)?.name ?? ''))) {
        found = mesh;
      }
    });
    return found;
  }

  /**
   * Which hand holds the bow and which pulls the string.
   *
   * Measured rather than assumed: the draw clip is sampled part-way through
   * and whichever wrist ends up further down-range is the one supporting the
   * bow. Everything that has to sit on the string — the nocked arrow, the
   * string itself — hangs off the other one.
   */
  private findHands(character: THREE.Object3D): void {
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
      const leftIsBowHand = leftZ >= rightZ;
      this.bowHand = leftIsBowHand ? left : right;
      this.stringHand = leftIsBowHand ? right : left;
    } else {
      this.bowHand = left ?? right;
    }

    if (this.drawAction) this.drawAction.time = 0;
    this.mixer?.update(0);
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
  private attachBow(_character: THREE.Object3D, bow: THREE.Object3D): void {
    this.bow = bow;
    this.prepareBow(bow);
    this.bowPivot.add(bow);
    this.buildString();
  }

  /**
   * Measure the limb tips and get rid of the bow's own string.
   *
   * The string modelled into the bow is rigid geometry — it cannot follow a
   * draw no matter how well the archer is animated — but it is a very precise
   * piece of geometry: hiding it costs nothing, and its own bounds give the
   * exact tip-to-tip line for the string drawn in code, which beats guessing at
   * a fraction of the bow's height.
   *
   * A strung bow also settles which way round the mesh is: the string sits on
   * the archer's side and the grip is pushed out toward the target.
   */
  private prepareBow(bow: THREE.Object3D): void {
    // Measured BEFORE parenting: Box3.setFromObject returns world bounds, so
    // afterwards these would be the bow's position in the scene instead.
    bow.updateWorldMatrix(false, true);
    const bounds = new THREE.Box3().setFromObject(bow);
    const size = new THREE.Vector3();
    const centre = new THREE.Vector3();
    bounds.getSize(size);
    bounds.getCenter(centre);

    const string = this.findModelledString(bow, size.y);
    if (!string) {
      this.limbTop.set(centre.x, centre.y + size.y * 0.45, centre.z);
      this.limbBottom.set(centre.x, centre.y - size.y * 0.45, centre.z);
      return;
    }

    const strung = new THREE.Box3().setFromObject(string);
    const along = new THREE.Vector3();
    strung.getCenter(along);
    this.limbTop.set(along.x, strung.max.y, along.z);
    this.limbBottom.set(along.x, strung.min.y, along.z);
    string.visible = false;

    // String on the far side of the grip means the mesh is back to front.
    if (along.z > centre.z) bow.rotation.y = Math.PI;
  }

  /**
   * The bow's own string: a needle of geometry running most of its height.
   * Matched on shape rather than on a material name, so a replacement bow mesh
   * is handled without editing this file.
   */
  private findModelledString(bow: THREE.Object3D, bowHeight: number): THREE.Mesh | null {
    let found: THREE.Mesh | null = null;
    const bounds = new THREE.Box3();
    const size = new THREE.Vector3();
    bow.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (found || !mesh.isMesh || !mesh.geometry) return;
      bounds.setFromObject(mesh).getSize(size);
      const dims = [size.x, size.y, size.z].sort((a, b) => b - a);
      if (dims[0] >= bowHeight * 0.6 && dims[1] <= dims[0] * 0.08) found = mesh;
    });
    return found;
  }

  /**
   * The nocked arrow.
   *
   * It hangs off its own pivot placed on the nock rather than being parented to
   * the bow, because the nock is the DRAWING hand: the shaft has to travel back
   * with the string as the shot is pulled, not sit welded to the grip.
   */
  private attachArrow(arrow: THREE.Object3D): void {
    arrow.updateWorldMatrix(false, true);
    const size = new THREE.Box3().setFromObject(arrow).getSize(new THREE.Vector3());
    this.arrowReach = size.z / 2;
    // The model points +z and is centred on itself, so half a length forward of
    // the pivot puts its tail on the string.
    arrow.position.set(0, 0, this.arrowReach);
    this.arrowPivot.add(arrow);
    this.arrow = arrow;
  }

  /**
   * A bowstring that actually bends.  /**
   * A bowstring that actually bends.
   *
   * The string modelled into the bow mesh is a straight, rigid piece of
   * geometry — it cannot follow a draw no matter how well the archer is
   * animated. This one runs limb tip → drawing hand → limb tip, and since the
   * hand is genuinely animated by the Mixamo clip, the string bends into a real
   * V as the shot is pulled and snaps flat on release.
   */
  private buildString(): void {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    // Matches the bow so the string reads as part of it, not as an overlay.
    const material = new THREE.LineBasicMaterial({ color: this.bowColour() });
    const line = new THREE.Line(geometry, material);
    line.frustumCulled = false;
    line.renderOrder = 6;
    this.stringLine = line;
    this.group.add(line);
  }

  /**
   * Rebuild the bowstring.
   *
   * The line lives under `group`, so each point is converted out of world
   * space before it is written — writing world coordinates into a child
   * applies the parent transform twice and throws the string across the scene.
   */
  private updateString(): void {
    const line = this.stringLine;
    const bow = this.bow;
    if (!line || !bow) return;

    if (this.phase !== 'ready') {
      line.visible = false;
      return;
    }

    const positions = line.geometry.getAttribute('position') as THREE.BufferAttribute;
    bow.updateWorldMatrix(true, false);

    this.scratch.copy(this.limbTop).applyMatrix4(bow.matrixWorld);
    this.group.worldToLocal(this.scratch);
    positions.setXYZ(0, this.scratch.x, this.scratch.y, this.scratch.z);

    // Nock: the drawing hand itself when there is one, otherwise the bow's
    // middle so the string at least stays strung.
    if (this.stringHand) this.stringHand.getWorldPosition(this.scratchB);
    else this.scratchB.set(0, 0, 0).applyMatrix4(bow.matrixWorld);
    this.group.worldToLocal(this.scratchB);
    positions.setXYZ(1, this.scratchB.x, this.scratchB.y, this.scratchB.z);

    this.scratch.copy(this.limbBottom).applyMatrix4(bow.matrixWorld);
    this.group.worldToLocal(this.scratch);
    positions.setXYZ(2, this.scratch.x, this.scratch.y, this.scratch.z);

    positions.needsUpdate = true;
    line.geometry.computeBoundingSphere();
    line.visible = true;
  }

  /**
   * The bow's own colour, sampled from its largest visible piece.
   *
   * Reading it off the mesh keeps the string matched to whatever bow is
   * shipped. It is lifted slightly toward white because a taut string catches
   * the light, and because the wood is dark enough to disappear at range.
   */
  private bowColour(): THREE.Color {
    const colour = new THREE.Color(0x8a5a2c);
    const bow = this.bow;
    if (bow) {
      let largest = -1;
      bow.traverse((child) => {
        const mesh = child as THREE.Mesh;
        // The modelled string is already hidden by now, so it is never sampled.
        if (!mesh.isMesh || !mesh.visible || !mesh.geometry) return;
        const count = mesh.geometry.getAttribute('position')?.count ?? 0;
        if (count <= largest) return;
        const first = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        const standard = first as THREE.MeshStandardMaterial | undefined;
        if (!standard?.color) return;
        largest = count;
        colour.copy(standard.color);
      });
    }
    return colour.lerp(new THREE.Color(0xffffff), 0.28);
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

  /**
   * Bend the spine to the shot's elevation.
   *
   * Applied after the mixer, which rewrites every animated bone from the clip
   * each frame, and as a rotation about the LANE's axis rather than the bone's
   * own — Mixamo's spine bones do not share the world's axes, so turning one
   * about its local x bends the archer sideways.
   */
  private applyAim(): void {
    if (!this.aimBones.length || this.phase !== 'ready') return;

    // The pitch axis is the facing group's own +x: inside it, +z is down-range.
    this.facingGroup.updateWorldMatrix(true, false);
    for (const { bone, share } of this.aimBones) {
      const parent = bone.parent;
      if (!parent) continue;
      parent.updateWorldMatrix(true, false);
      this.pitchAxis.set(1, 0, 0).transformDirection(this.facingGroup.matrixWorld);
      this.parentSpace.copy(parent.matrixWorld).invert();
      this.pitchAxis.transformDirection(this.parentSpace).normalize();
      this.tilt.setFromAxisAngle(this.pitchAxis, -this.pitch * share);
      bone.quaternion.premultiply(this.tilt);
    }
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
    this.arrowGone = true;
    if (this.phase === 'ready') this.loosing = true;
  }

  /** Put a fresh arrow on the string. Idempotent. */
  nock(): void {
    this.arrowGone = false;
  }

  /** How long the fall itself takes, in seconds. */
  get fallSeconds(): number {
    return this.deathAction?.getClip().duration ?? 1.4;
  }

  /**
   * Take a hit: go down with the death clip, then rise by reversing it.
   *
   * `final` is the hit that ended the match. There is no getting up from it —
   * an archer on zero health used to stand back up and only then be shown the
   * result card, which read as surviving and then losing anyway.
   */
  knockDown(final = false): void {
    this.flashUntil = performance.now() + 340;
    this.drawAmount = 0;
    this.scrub = 0;
    this.loosing = false;
    // Whoever gets back up is holding an arrow again.
    this.arrowGone = false;
    this.defeated = final;
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
      // Defeated: the death clip clamps on its last frame and stays there.
      if (this.defeated) return;
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

    // The hand stays empty after a shot until the next pull begins, which is
    // also what re-arms an opponent nobody calls nock() for.
    if (this.arrowGone && !this.loosing && this.drawAmount > 0) this.arrowGone = false;

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
    this.applyAim();
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

    // The arrow rides the drawing hand, so it travels back with the string as
    // the draw builds, and it lies along the elevation the shot will actually
    // leave at rather than along the bow's damped tilt.
    if (this.stringHand) {
      this.stringHand.getWorldPosition(this.scratch);
      this.facingGroup.worldToLocal(this.scratch);
      this.arrowPivot.position.copy(this.scratch);
    } else {
      this.arrowPivot.position.copy(this.bowPivot.position);
      this.arrowPivot.position.z -= this.arrowReach;
    }
    // Along the line between the hands, so the shaft passes over the grip and
    // stays with the arms wherever the aim has put them — rather than being
    // pitched on its own, which left it climbing while the bow stood still.
    if (this.bowHand) {
      this.bowHand.getWorldPosition(this.scratchB);
      this.arrowPivot.lookAt(this.scratchB);
    } else {
      this.arrowPivot.rotation.x = -this.pitch;
    }
    this.arrowPivot.visible = this.arrow !== null && this.phase === 'ready' && !this.arrowGone;

    // Her own bowstring: the nocking-point bone is moved onto the drawing
    // hand, which is all a bowstring does. The vertices around it are weighted
    // to the limbs, so they stay put and the string bends into a V.
    if (this.stringBone && this.stringHand && this.stringBone.parent) {
      this.stringHand.getWorldPosition(this.scratch);
      this.stringBone.parent.worldToLocal(this.scratch);
      this.stringBone.position.copy(this.scratch);
    }

    // The drawn-in-code string is rebuilt last, once the bow and the hands
    // have moved. It exists only for a bow that has no string of its own.
    this.group.updateWorldMatrix(true, true);
    this.updateString();

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
        // Back to whatever the outfit set, not to black: the team colour is
        // carried partly by emissive, and zeroing it stripped the archer of
        // its colour the first time it was hit.
        const base = standard.userData.baseEmissive as
          | { hex: number; intensity: number }
          | undefined;
        standard.emissive.setHex(flashing ? 0xff3b30 : (base?.hex ?? 0x000000));
        standard.emissiveIntensity = flashing ? 0.6 : (base?.intensity ?? 0);
      }
    });
  }

  dispose(): void {
    this.stringLine?.geometry.dispose();
    this.mixer?.stopAllAction();
    this.group.removeFromParent();
  }
}
