/**
 * Camera direction.
 *
 * The camera watches whoever is about to shoot: on your turn it sits over your
 * shoulder, and when the opponent draws it travels down the range to stand
 * behind them, so you see the shot that is coming rather than a distant speck.
 * While an arrow is in the air it trails the arrow instead.
 *
 * All moves are smoothed toward the requested viewpoint, so switching ends is a
 * sweep across the range rather than a cut.
 */

import * as THREE from 'three';

/** Over-the-shoulder offsets, in metres, relative to the archer's feet. */
const EYE_BACK = 4.4;
const EYE_UP = 2.5;
const EYE_SIDE = 0.5;
const LOOK_AHEAD = 18;
const LOOK_UP = 1.3;

/** Trailing offsets while following an arrow. */
const ARROW_BACK = 6.5;
const ARROW_UP = 2.2;

export type ViewRequest =
  | {
      kind: 'shoulder';
      origin: THREE.Vector3;
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

export class CameraDirector {
  private readonly eye = new THREE.Vector3(0, 3, -5);
  private readonly focus = new THREE.Vector3(0, 1.5, 10);
  private readonly desiredEye = new THREE.Vector3();
  private readonly desiredFocus = new THREE.Vector3();
  private readonly heading = new THREE.Vector3();
  private primed = false;

  /** Jump straight to the requested view — use when the arena changes. */
  snap(): void {
    this.primed = false;
  }

  private computeDesired(view: ViewRequest): void {
    if (view.kind === 'shoulder') {
      const { origin, facing, pitch } = view;
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

    this.heading.copy(view.heading);
    if (this.heading.lengthSq() < 1e-8) this.heading.set(0, 0, 1);
    this.heading.normalize();

    // Sit behind and above the arrow, looking a little ahead of it.
    this.desiredEye
      .copy(view.at)
      .addScaledVector(this.heading, -ARROW_BACK)
      .add(new THREE.Vector3(0, ARROW_UP, 0));
    this.desiredFocus.copy(view.at).addScaledVector(this.heading, 6);
  }

  /**
   * Advance toward the requested view and return the camera placement.
   *
   * Framerate-independent smoothing: the same fraction of the remaining gap is
   * closed per second whatever the frame time.
   */
  update(view: ViewRequest, deltaSeconds: number): CameraView {
    this.computeDesired(view);

    if (!this.primed) {
      this.eye.copy(this.desiredEye);
      this.focus.copy(this.desiredFocus);
      this.primed = true;
      return { eye: this.eye, focus: this.focus };
    }

    // A shot in flight needs a tighter follow than a lazy sweep between ends.
    const rate = view.kind === 'flight' ? 9 : 3.2;
    const blend = 1 - Math.exp(-rate * Math.max(0.001, Math.min(0.1, deltaSeconds)));
    this.eye.lerp(this.desiredEye, blend);
    this.focus.lerp(this.desiredFocus, blend);
    return { eye: this.eye, focus: this.focus };
  }
}
