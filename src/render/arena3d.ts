/**
 * Builds an arena in 3D: ground, the platforms the archers stand on, the
 * scenery props, plus the two things that move — the aiming guide and the arrow
 * in flight.
 *
 * The arrow is driven from a pre-computed path produced by `sim.ts`, not from
 * physics running here. That is what lets both players (and a rejoining player)
 * watch the identical shot.
 */

import * as THREE from 'three';

import { instantiate } from './models';
import type { ModelKey } from './models';
import type { ArenaDefinition } from '../arenas';
import type { Vec2 } from '../sim';

/** Everything lives on this Z plane so the 2D sim matches what is drawn. */
export const PLAY_Z = 0;

const GUIDE_SEGMENTS = 26;

export class ArenaView {
  readonly group = new THREE.Group();

  private readonly guide: THREE.Line;
  private readonly guideGeometry: THREE.BufferGeometry;
  private arrow: THREE.Object3D | null = null;
  private readonly arrowTrail: THREE.Points;
  private readonly trailGeometry: THREE.BufferGeometry;
  private trailCount = 0;
  private disposables: Array<{ dispose(): void }> = [];

  constructor() {
    this.guideGeometry = new THREE.BufferGeometry();
    this.guideGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(GUIDE_SEGMENTS * 3), 3),
    );
    const guideMaterial = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.72,
      depthTest: false,
    });
    this.guide = new THREE.Line(this.guideGeometry, guideMaterial);
    this.guide.visible = false;
    this.guide.renderOrder = 8;
    this.group.add(this.guide);
    this.disposables.push(this.guideGeometry, guideMaterial);

    this.trailGeometry = new THREE.BufferGeometry();
    this.trailGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(140 * 3), 3),
    );
    const trailMaterial = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.11,
      transparent: true,
      opacity: 0.45,
      depthTest: false,
      sizeAttenuation: true,
    });
    this.arrowTrail = new THREE.Points(this.trailGeometry, trailMaterial);
    this.arrowTrail.visible = false;
    this.arrowTrail.renderOrder = 7;
    this.group.add(this.arrowTrail);
    this.disposables.push(this.trailGeometry, trailMaterial);
  }

  /** Rebuild the whole set for a new arena. */
  async build(arena: ArenaDefinition): Promise<void> {
    this.clearSet();

    const groundMaterial = new THREE.MeshStandardMaterial({
      color: arena.palette.ground,
      roughness: 0.95,
      metalness: 0,
    });
    const groundGeometry = new THREE.PlaneGeometry(220, 120);
    const ground = new THREE.Mesh(groundGeometry, groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, 0, -18);
    ground.receiveShadow = true;
    ground.userData.set = true;
    this.group.add(ground);
    this.disposables.push(groundGeometry, groundMaterial);

    const platformMaterial = new THREE.MeshStandardMaterial({
      color: arena.palette.groundAccent,
      roughness: 0.9,
      metalness: 0,
    });
    this.disposables.push(platformMaterial);

    for (const platform of arena.platforms) {
      const geometry = new THREE.BoxGeometry(platform.w, platform.h, platform.depth);
      const mesh = new THREE.Mesh(geometry, platformMaterial);
      mesh.position.set(
        platform.x + platform.w / 2,
        platform.y + platform.h / 2,
        PLAY_Z - platform.depth / 2 + 1.4,
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.set = true;
      this.group.add(mesh);
      this.disposables.push(geometry);
    }

    // Props are decorative — a failed one must never stop the match.
    await Promise.all(
      arena.props.map(async (prop) => {
        try {
          const model = await instantiate(prop.model as ModelKey);
          model.position.set(prop.at.x, prop.at.y, prop.z ?? PLAY_Z - 2);
          model.rotation.y = prop.rotationY;
          model.scale.multiplyScalar(prop.scale);
          model.userData.set = true;
          this.group.add(model);
        } catch (error) {
          console.warn(`[archers-arena] prop "${prop.model}" skipped`, error);
        }
      }),
    );

    if (!this.arrow) {
      try {
        const arrow = await instantiate('arrow');
        arrow.visible = false;
        this.arrow = arrow;
        this.group.add(arrow);
      } catch {
        // Fall back to a simple shaft so a shot is always visible.
        const geometry = new THREE.CylinderGeometry(0.022, 0.022, 0.78, 6);
        const material = new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.8 });
        const shaft = new THREE.Mesh(geometry, material);
        shaft.rotation.z = Math.PI / 2;
        const wrapper = new THREE.Group();
        wrapper.add(shaft);
        wrapper.visible = false;
        this.arrow = wrapper;
        this.group.add(wrapper);
        this.disposables.push(geometry, material);
      }
    }
  }

  private clearSet(): void {
    const doomed = this.group.children.filter((child) => child.userData.set === true);
    for (const child of doomed) this.group.remove(child);
  }

  /** Short dotted guide showing launch direction only, like the original. */
  showGuide(path: Vec2[], colour: number): void {
    if (path.length < 2) {
      this.guide.visible = false;
      return;
    }
    const positions = this.guideGeometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < GUIDE_SEGMENTS; i += 1) {
      const sample = path[Math.min(path.length - 1, Math.floor((i / (GUIDE_SEGMENTS - 1)) * (path.length - 1)))];
      positions.setXYZ(i, sample.x, sample.y, PLAY_Z);
    }
    positions.needsUpdate = true;
    (this.guide.material as THREE.LineBasicMaterial).color.setHex(colour);
    this.guide.visible = true;
  }

  hideGuide(): void {
    this.guide.visible = false;
  }

  /** Place the arrow along its flight path and point it down its velocity. */
  setArrow(point: Vec2, previous: Vec2 | null): void {
    if (!this.arrow) return;
    this.arrow.visible = true;
    this.arrow.position.set(point.x, point.y, PLAY_Z);
    if (previous) {
      const angle = Math.atan2(point.y - previous.y, point.x - previous.x);
      this.arrow.rotation.set(0, 0, angle);
    }
  }

  hideArrow(): void {
    if (this.arrow) this.arrow.visible = false;
    this.arrowTrail.visible = false;
    this.trailCount = 0;
  }

  pushTrail(point: Vec2): void {
    const positions = this.trailGeometry.getAttribute('position') as THREE.BufferAttribute;
    const capacity = positions.count;
    if (this.trailCount < capacity) {
      positions.setXYZ(this.trailCount, point.x, point.y, PLAY_Z);
      this.trailCount += 1;
    } else {
      // Shift by one and append — the trail is short, so this stays cheap.
      for (let i = 1; i < capacity; i += 1) {
        positions.setXYZ(i - 1, positions.getX(i), positions.getY(i), PLAY_Z);
      }
      positions.setXYZ(capacity - 1, point.x, point.y, PLAY_Z);
    }
    this.trailGeometry.setDrawRange(0, this.trailCount);
    positions.needsUpdate = true;
    this.trailGeometry.computeBoundingSphere();
    this.arrowTrail.visible = true;
  }

  clearTrail(): void {
    this.trailCount = 0;
    this.trailGeometry.setDrawRange(0, 0);
    this.arrowTrail.visible = false;
  }

  dispose(): void {
    for (const item of this.disposables) item.dispose();
    this.disposables = [];
  }
}
