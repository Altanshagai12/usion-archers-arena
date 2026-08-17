/**
 * Drag-to-aim.
 *
 * Press anywhere and pull back: the drag vector sets both the bow angle and the
 * draw strength, exactly like pulling a real bowstring, and releasing fires.
 * That is one gesture for the whole game — no separate angle slider, no power
 * button, and it works identically with a mouse or a thumb.
 *
 * `facing` mirrors the gesture for the archer on the right, so "pull back"
 * always means "away from the opponent" for both players.
 */

import { MAX_ANGLE, MIN_ANGLE, MIN_POWER } from './sim';

/** Drag length, in CSS pixels, that corresponds to a fully drawn bow. */
const FULL_DRAW_PX = 190;

export interface AimEvent {
  angle: number;
  power: number;
}

export interface AimCallbacks {
  onStart(): void;
  onMove(aim: AimEvent): void;
  onRelease(aim: AimEvent): void;
  onCancel(): void;
}

export class AimController {
  private pointerId: number | null = null;
  private originX = 0;
  private originY = 0;
  private facing: 1 | -1 = 1;
  private enabled = false;
  private current: AimEvent = { angle: 0.6, power: 0.6 };

  constructor(
    private readonly surface: HTMLElement,
    private readonly callbacks: AimCallbacks,
  ) {
    surface.addEventListener('pointerdown', this.handleDown);
    surface.addEventListener('pointermove', this.handleMove);
    surface.addEventListener('pointerup', this.handleUp);
    surface.addEventListener('pointercancel', this.handleCancel);
    // Stop the host WebView from treating a drag as a scroll or a pull-to-refresh.
    surface.style.touchAction = 'none';
  }

  setEnabled(enabled: boolean, facing: 1 | -1 = this.facing): void {
    this.facing = facing;
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.abort();
  }

  get isAiming(): boolean {
    return this.pointerId !== null;
  }

  get aim(): AimEvent {
    return this.current;
  }

  private compute(x: number, y: number): AimEvent {
    const dx = x - this.originX;
    const dy = y - this.originY;

    // Pull back to shoot forward; screen-down means aim up.
    const forward = -dx * this.facing;
    const up = dy;

    const length = Math.hypot(dx, dy);
    const power = Math.max(MIN_POWER, Math.min(1, length / FULL_DRAW_PX));

    // Below a few pixels the direction is noise — hold the previous angle.
    const angle =
      length < 6
        ? this.current.angle
        : Math.max(MIN_ANGLE, Math.min(MAX_ANGLE, Math.atan2(up, forward)));

    return { angle, power };
  }

  private readonly handleDown = (event: PointerEvent): void => {
    if (!this.enabled || this.pointerId !== null) return;
    this.pointerId = event.pointerId;
    this.originX = event.clientX;
    this.originY = event.clientY;
    this.current = { angle: this.current.angle, power: MIN_POWER };
    this.surface.setPointerCapture(event.pointerId);
    event.preventDefault();
    this.callbacks.onStart();
    this.callbacks.onMove(this.current);
  };

  private readonly handleMove = (event: PointerEvent): void => {
    if (this.pointerId !== event.pointerId) return;
    this.current = this.compute(event.clientX, event.clientY);
    event.preventDefault();
    this.callbacks.onMove(this.current);
  };

  private readonly handleUp = (event: PointerEvent): void => {
    if (this.pointerId !== event.pointerId) return;
    const aim = this.compute(event.clientX, event.clientY);
    this.release(event.pointerId);
    event.preventDefault();
    this.callbacks.onRelease(aim);
  };

  private readonly handleCancel = (event: PointerEvent): void => {
    if (this.pointerId !== event.pointerId) return;
    this.release(event.pointerId);
    this.callbacks.onCancel();
  };

  private release(pointerId: number): void {
    this.pointerId = null;
    try {
      this.surface.releasePointerCapture(pointerId);
    } catch {
      // Already released — nothing to undo.
    }
  }

  private abort(): void {
    if (this.pointerId === null) return;
    this.release(this.pointerId);
    this.callbacks.onCancel();
  }

  dispose(): void {
    this.surface.removeEventListener('pointerdown', this.handleDown);
    this.surface.removeEventListener('pointermove', this.handleMove);
    this.surface.removeEventListener('pointerup', this.handleUp);
    this.surface.removeEventListener('pointercancel', this.handleCancel);
  }
}
