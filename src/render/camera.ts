/**
 * Camera direction.
 *
 * Three viewpoints, and the moves between them are the point:
 *
 *   shoulder  behind you while you aim — the view you play from
 *   approach  the same sight line, flown in close to the opponent, so you watch
 *             them raise the bow with the shot still coming toward you
 *   flight    trailing an arrow while it is in the air
 *
 * Switching viewpoint is a timed, eased glide rather than a cut: the camera
 * visibly travels down the range. Once it has arrived it tracks with fast
 * exponential smoothing, so small movements stay responsive.
 */

import * as THREE from 'three';

/** Over-the-shoulder offsets, in metres, relative to the archer's feet. */
const EYE_BACK = 4.4;
const EYE_UP = 2.5;
const EYE_SIDE = 0.5;
const LOOK_AHEAD = 18;
const LOOK_UP = 1.3;

/**
 * Approach view: the camera keeps YOUR line of sight and simply flies down the
 * lane until it is standing close to the opponent. It never crosses behind
 * them, so the shot still reads as coming toward you.
 */
const APPROACH_BACK = 5.4;
const APPROACH_SIDE = 1.2;
const APPROACH_UP = 1.95;
const APPROACH_LOOK_UP = 1.3;

/** Trailing offsets while following an arrow. */
const ARROW_BACK = 6.5;
const ARROW_UP = 2.2;

/** How long the camera takes to travel when the viewpoint changes. */
const TRAVEL_SECONDS: Record<string, number> = {
  shoulder: 1.05,
  approach: 1.15,
  flight: 0.4,
};

export type ViewRequest =
  | {
      kind: 'shoulder' | 'approach';
      /** Which archer this view is of — part of the viewpoint identity. */
      seat: 0 | 1;
      origin: THREE.Vector3;
      /** The direction the VIEWER shoots, so approach never crosses the lane. */
      facing: 1 | -1;
      pitch: number;
    }
  | {
      kind: 'flight';
      /** Current arrow position. */
      at: THREE.Vector3;
      /** Direction of travel, need not be normalised. */
      heading: THREE.Vector3;
    };

export interface CameraView {
  eye: THREE.Vector3;
  focus: THREE.Vector3;
}

function smoothstep(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

export class CameraDirector {
  private readonly eye = new THREE.Vector3(0, 3, -5);
  private readonly focus = new THREE.Vector3(0, 1.5, 10);
  private readonly desiredEye = new THREE.Vector3();
  private readonly desiredFocus = new THREE.Vector3();
  private readonly fromEye = new THREE.Vector3();
  private readonly fromFocus = new THREE.Vector3();
  private readonly heading = new THREE.Vector3();

  private key = '';
  private travel = 1;
  private travelSeconds = 1;
  private primed = false;

  /** Jump straight to the requested view — use when the arena changes. */
  snap(): void {
    this.primed = false;
    this.key = '';
  }

  /** True while the camera is still travelling to a new viewpoint. */
  get isTravelling(): boolean {
    return this.travel < 1;
  }

  private computeDesired(view: ViewRequest): void {
    if (view.kind === 'flight') {
      this.heading.copy(view.heading);
      if (this.heading.lengthSq() < 1e-8) this.heading.set(0, 0, 1);
      this.heading.normalize();

      this.desiredEye.copy(view.at).addScaledVector(this.heading, -ARROW_BACK);
      this.desiredEye.y += ARROW_UP;
      this.desiredFocus.copy(view.at).addScaledVector(this.heading, 6);
      return;
    }

    const { origin, facing, pitch } = view;

    if (view.kind === 'shoulder') {
      this.desiredEye.set(
        origin.x + EYE_SIDE * facing,
        origin.y + EYE_UP,
        origin.z - EYE_BACK * facing,
      );
      this.desiredFocus.set(
        origin.x,
        origin.y + LOOK_UP + Math.sin(pitch) * 9,
        origin.z + LOOK_AHEAD * facing,
      );
      return;
    }

    // Approach: still on your side of them, just much closer — the camera
    // travels straight down your own sight line rather than swinging around.
    this.desiredEye.set(
      origin.x + APPROACH_SIDE,
      origin.y + APPROACH_UP,
      origin.z - APPROACH_BACK * facing,
    );
    this.desiredFocus.set(origin.x, origin.y + APPROACH_LOOK_UP, origin.z);
  }

  /**
   * Advance toward the requested view and return the camera placement.
   *
   * A change of viewpoint starts a timed glide; within one viewpoint the
   * camera tracks with framerate-independent exponential smoothing.
   */
  update(view: ViewRequest, deltaSeconds: number): CameraView {
    const dt = Math.max(0.001, Math.min(0.1, deltaSeconds));
    this.computeDesired(view);

    const key = view.kind === 'flight' ? 'flight' : `${view.kind}:${view.seat}`;

    if (!this.primed) {
      this.eye.copy(this.desiredEye);
      this.focus.copy(this.desiredFocus);
      this.primed = true;
      this.key = key;
      this.travel = 1;
      return { eye: this.eye, focus: this.focus };
    }

    if (key !== this.key) {
      this.key = key;
      this.fromEye.copy(this.eye);
      this.fromFocus.copy(this.focus);
      this.travel = 0;
      this.travelSeconds = TRAVEL_SECONDS[view.kind] ?? 1;
    }

    if (this.travel < 1) {
      this.travel = Math.min(1, this.travel + dt / this.travelSeconds);
      const eased = smoothstep(this.travel);
      this.eye.lerpVectors(this.fromEye, this.desiredEye, eased);
      this.focus.lerpVectors(this.fromFocus, this.desiredFocus, eased);
      return { eye: this.eye, focus: this.focus };
    }

    const rate = view.kind === 'flight' ? 9 : 4;
    const blend = 1 - Math.exp(-rate * dt);
    this.eye.lerp(this.desiredEye, blend);
    this.focus.lerp(this.desiredFocus, blend);
    return { eye: this.eye, focus: this.focus };
  }
}
