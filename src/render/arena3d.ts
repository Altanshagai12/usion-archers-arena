/**
 * Builds the shooting range in 3D: ground, the mounds the archers stand on,
 * the distant ridge line, the scenery props — plus the two things that move,
 * the aiming tracer and the arrow in flight.
 *
 * The arrow is driven from a path pre-computed by `sim.ts`, not from physics
 * running here. That is what lets both players — and one who just rejoined —
 * watch the identical shot.
 */

import * as THREE from 'three';

import { instantiate } from './models';
import type { ModelKey } from './models';
import type { ArenaDefinition } from '../arenas';
import type { Vec3 } from '../sim';

const TRACER_POINTS = 16;
const TRAIL_POINTS = 90;

/**
 * A soft round dot, drawn once and reused by both the aim tracer and the
 * arrow's trail.
 *
 * Thin lines read as debug overlay rather than as part of the game, so both
 * are chunky spaced dots instead — the same shorthand the original uses for
 * its aim arc.
 */
function dotTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.55, 'rgba(255,255,255,0.95)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 64, 64);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export class ArenaView {
  readonly group = new THREE.Group();

  private readonly tracer: THREE.Points;
  private readonly tracerGeometry: THREE.BufferGeometry;
  private readonly trail: THREE.Points;
  private readonly trailGeometry: THREE.BufferGeometry;
  private trailCount = 0;

  private arrow: THREE.Object3D | null = null;
  /** Arrows left standing where they landed, oldest first. */
  private readonly stuck: THREE.Object3D[] = [];
  private readonly aimTarget = new THREE.Vector3();
  private disposables: Array<{ dispose(): void }> = [];

  constructor() {
    this.tracerGeometry = new THREE.BufferGeometry();
    this.tracerGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(TRACER_POINTS * 3), 3),
    );
    const dot = dotTexture();
    this.disposables.push(dot);

    const tracerMaterial = new THREE.PointsMaterial({
      color: 0x5fd8ff,
      map: dot,
      size: 0.34,
      sizeAttenuation: true,
      transparent: true,
      depthWrite: false,
      depthTest: false,
    });
    this.tracer = new THREE.Points(this.tracerGeometry, tracerMaterial);
    this.tracer.visible = false;
    this.tracer.renderOrder = 8;
    this.tracer.frustumCulled = false;
    this.group.add(this.tracer);
    this.disposables.push(this.tracerGeometry, tracerMaterial);

    this.trailGeometry = new THREE.BufferGeometry();
    this.trailGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(TRAIL_POINTS * 3), 3),
    );
    const trailMaterial = new THREE.PointsMaterial({
      color: 0xdff4ff,
      map: dot,
      size: 0.2,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
    });
    this.trail = new THREE.Points(this.trailGeometry, trailMaterial);
    this.trail.visible = false;
    this.trail.renderOrder = 7;
    this.trail.frustumCulled = false;
    this.group.add(this.trail);
    this.disposables.push(this.trailGeometry, trailMaterial);
  }

  /** Rebuild the whole set for a new arena. */
  async build(arena: ArenaDefinition): Promise<void> {
    this.clearSet();

    const centreZ = arena.range / 2;

    const groundGeometry = new THREE.PlaneGeometry(420, 620);
    const groundMaterial = new THREE.MeshStandardMaterial({
      color: arena.palette.ground,
      roughness: 0.98,
      metalness: 0,
    });
    const ground = new THREE.Mesh(groundGeometry, groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, 0, centreZ);
    ground.receiveShadow = true;
    ground.userData.set = true;
    this.group.add(ground);
    this.disposables.push(groundGeometry, groundMaterial);

    // A slightly darker strip marks the lane between the two archers.
    const laneGeometry = new THREE.PlaneGeometry(20, arena.range + 26);
    const laneMaterial = new THREE.MeshStandardMaterial({
      color: arena.palette.groundAccent,
      roughness: 0.98,
      metalness: 0,
    });
    const lane = new THREE.Mesh(laneGeometry, laneMaterial);
    lane.rotation.x = -Math.PI / 2;
    lane.position.set(0, 0.01, centreZ);
    lane.receiveShadow = true;
    lane.userData.set = true;
    this.group.add(lane);
    this.disposables.push(laneGeometry, laneMaterial);

    this.buildRidges(arena);
    this.buildMounds(arena);

    // Props are decorative — a failed one must never stop the match.
    await Promise.all(
      arena.props.map(async (prop) => {
        try {
          const model = await instantiate(prop.model as ModelKey);
          model.position.set(prop.at.x, prop.at.y, prop.at.z);
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
      const arrow = await instantiate('arrow');
      arrow.visible = false;
      arrow.frustumCulled = false;
      this.arrow = arrow;
      this.group.add(arrow);
    }
  }

  private buildRidges(arena: ArenaDefinition): void {
    const material = new THREE.MeshStandardMaterial({
      color: arena.palette.ridge,
      roughness: 1,
      metalness: 0,
      flatShading: true,
    });
    this.disposables.push(material);

    // Two staggered bands of peaks give the horizon depth without a skybox.
    const bands = [
      { z: arena.range + 150, scale: 1, jitter: 0 },
      { z: arena.range + 230, scale: 1.5, jitter: 26 },
    ];

    for (const band of bands) {
      for (const [x, height, radius] of arena.ridges) {
        const geometry = new THREE.ConeGeometry(radius * band.scale, height * band.scale, 5, 1);
        const peak = new THREE.Mesh(geometry, material);
        peak.position.set((x + band.jitter) * band.scale, (height * band.scale) / 2 - 2, band.z);
        peak.rotation.y = x * 0.13;
        peak.userData.set = true;
        this.group.add(peak);
        this.disposables.push(geometry);
      }
    }
  }

  private buildMounds(arena: ArenaDefinition): void {
    const material = new THREE.MeshStandardMaterial({
      color: arena.palette.groundAccent,
      roughness: 0.97,
      metalness: 0,
    });
    this.disposables.push(material);

    for (const mound of arena.mounds) {
      if (mound.height <= 0.01) continue;
      const geometry = new THREE.CylinderGeometry(
        mound.radius,
        mound.radius * 1.28,
        mound.height,
        20,
      );
      const node = new THREE.Mesh(geometry, material);
      node.position.set(mound.at.x, mound.height / 2, mound.at.z);
      node.castShadow = true;
      node.receiveShadow = true;
      node.userData.set = true;
      this.group.add(node);
      this.disposables.push(geometry);
    }
  }

  private clearSet(): void {
    const doomed = this.group.children.filter((child) => child.userData.set === true);
    for (const child of doomed) this.group.remove(child);
    this.stuck.length = 0;
  }

  /** Short tracer showing launch direction only, like the original. */
  showTracer(path: Vec3[], colour: number): void {
    if (path.length < 2) {
      this.tracer.visible = false;
      return;
    }
    const positions = this.tracerGeometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < TRACER_POINTS; i += 1) {
      const index = Math.min(
        path.length - 1,
        Math.floor((i / (TRACER_POINTS - 1)) * (path.length - 1)),
      );
      const p = path[index];
      positions.setXYZ(i, p.x, p.y, p.z);
    }
    positions.needsUpdate = true;
    (this.tracer.material as THREE.PointsMaterial).color.setHex(colour);
    this.tracer.visible = true;
  }

  hideTracer(): void {
    this.tracer.visible = false;
  }

  /** Place the arrow along its flight path and point it down its velocity. */
  setArrow(point: Vec3, previous: Vec3 | null): void {
    if (!this.arrow) return;
    this.arrow.visible = true;
    this.arrow.position.set(point.x, point.y, point.z);
    if (previous) {
      // The mesh points along +z, so just aim it at where it is heading.
      this.aimTarget.set(
        point.x + (point.x - previous.x),
        point.y + (point.y - previous.y),
        point.z + (point.z - previous.z),
      );
      this.arrow.lookAt(this.aimTarget);
    }
  }

  hideArrow(): void {
    if (this.arrow) this.arrow.visible = false;
    this.trail.visible = false;
  }

  /**
   * Leave an arrow standing where this one landed.
   *
   * A shot that vanishes on impact gives the player nothing to read; a shaft
   * sticking out of the ground (or the target) shows exactly how far off the
   * last attempt was, which is how you walk the next one in.
   */
  stickArrow(point: Vec3, previous: Vec3 | null): void {
    if (!this.arrow) return;
    const shaft = this.arrow.clone(true);
    shaft.visible = true;
    shaft.frustumCulled = false;
    shaft.userData.set = true;
    shaft.position.set(point.x, point.y, point.z);
    if (previous) {
      this.aimTarget.set(
        point.x + (point.x - previous.x),
        point.y + (point.y - previous.y),
        point.z + (point.z - previous.z),
      );
      shaft.lookAt(this.aimTarget);
    }
    this.group.add(shaft);
    this.stuck.push(shaft);

    // Keep the field readable rather than a pincushion.
    while (this.stuck.length > 8) {
      const oldest = this.stuck.shift();
      if (oldest) this.group.remove(oldest);
    }
  }

  pushTrail(point: Vec3): void {
    const positions = this.trailGeometry.getAttribute('position') as THREE.BufferAttribute;
    if (this.trailCount >= positions.count) return;
    positions.setXYZ(this.trailCount, point.x, point.y, point.z);
    this.trailCount += 1;
    this.trailGeometry.setDrawRange(0, this.trailCount);
    positions.needsUpdate = true;
    this.trail.visible = true;
  }

  clearTrail(): void {
    this.trailCount = 0;
    this.trailGeometry.setDrawRange(0, 0);
    this.trail.visible = false;
  }

  dispose(): void {
    for (const item of this.disposables) item.dispose();
    this.disposables = [];
  }
}
