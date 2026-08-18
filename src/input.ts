/**
 * Aiming: hold, move up or down to set elevation, release to shoot.
 *
 * Three quantities come out of one gesture, deliberately decoupled so they
 * never fight each other:
 *
 *   vertical drag → pitch (the number on the elevation gauge)
 *   time held     → draw strength, which fills like a real bowstring
 *
 * Horizontal movement does nothing on purpose: both archers stand on the same
 * line, so elevation is the only thing there is to judge.
 *
 * Pitch resumes from the last shot rather than resetting, so walking your aim
 * in — the whole skill of the game — is a small nudge rather than a re-aim.
 */

import { MAX_PITCH, MIN_PITCH, MIN_POWER, clampPitch } from './sim';

/** Vertical pixels that sweep the entire elevation range. */
const PITCH_TRAVEL_PX = 340;
/** Seconds of hold to go from the minimum draw to full. */
const FULL_DRAW_SECONDS = 1.05;
/** A release before this reads as a mis-tap, not a shot. */
const MIN_HOLD_MS = 190;

export interface AimEvent {
  pitch: number;
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
  private originY = 0;
  private startedAt = 0;
  private pitchAtStart = 0.25;
  private enabled = false;
  private current: AimEvent = { pitch: 0.25, power: MIN_POWER };
  private frame = 0;

  constructor(
    private readonly surface: HTMLElement,
    private readonly callbacks: AimCallbacks,
  ) {
    surface.addEventListener('pointerdown', this.handleDown);
    surface.addEventListener('pointermove', this.handleMove);
    surface.addEventListener('pointerup', this.handleUp);
    surface.addEventListener('pointercancel', this.handleCancel);
    // Stop the host WebView treating a drag as a scroll or pull-to-refresh.
    surface.style.touchAction = 'none';
  }

  setEnabled(enabled: boolean): void {
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

  /** Start the next shot from a known elevation (e.g. after a rebuild). */
  resetPitch(pitch: number): void {
    this.current = { ...this.current, pitch: clampPitch(pitch) };
  }

  private compute(_x: number, y: number, nowMs: number): AimEvent {
    const dy = y - this.originY;

    // Pull down to raise the bow, the way you lift a sight onto a far target.
    // Horizontal movement is deliberately ignored: both archers stand on the
    // same line, so there is nothing to aim across.
    const pitch = clampPitch(
      this.pitchAtStart + (dy / PITCH_TRAVEL_PX) * (MAX_PITCH - MIN_PITCH),
    );

    const held = (nowMs - this.startedAt) / 1000;
    const power = Math.min(1, MIN_POWER + (held / FULL_DRAW_SECONDS) * (1 - MIN_POWER));

    return { pitch, power };
  }

  /** The draw keeps filling while the finger is still, so drive it per frame. */
  private readonly tick = (): void => {
    if (this.pointerId === null) return;
    this.frame = requestAnimationFrame(this.tick);
    this.current = this.compute(this.lastX, this.lastY, performance.now());
    this.callbacks.onMove(this.current);
  };

  private lastX = 0;
  private lastY = 0;

  private readonly handleDown = (event: PointerEvent): void => {
    if (!this.enabled || this.pointerId !== null) return;
    this.pointerId = event.pointerId;
    this.originY = event.clientY;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    this.startedAt = performance.now();
    this.pitchAtStart = this.current.pitch;
    this.surface.setPointerCapture(event.pointerId);
    event.preventDefault();
    this.callbacks.onStart();
    this.frame = requestAnimationFrame(this.tick);
  };

  private readonly handleMove = (event: PointerEvent): void => {
    if (this.pointerId !== event.pointerId) return;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    event.preventDefault();
  };

  private readonly handleUp = (event: PointerEvent): void => {
    if (this.pointerId !== event.pointerId) return;
    const now = performance.now();
    const held = now - this.startedAt;
    const aim = this.compute(event.clientX, event.clientY, now);
    this.release(event.pointerId);
    event.preventDefault();

    if (held < MIN_HOLD_MS) {
      // A stray tap must never burn a turn.
      this.callbacks.onCancel();
      return;
    }
    this.current = aim;
    this.callbacks.onRelease(aim);
  };

  private readonly handleCancel = (event: PointerEvent): void => {
    if (this.pointerId !== event.pointerId) return;
    this.release(event.pointerId);
    this.callbacks.onCancel();
  };

  private release(pointerId: number): void {
    this.pointerId = null;
    cancelAnimationFrame(this.frame);
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
    cancelAnimationFrame(this.frame);
    this.surface.removeEventListener('pointerdown', this.handleDown);
    this.surface.removeEventListener('pointermove', this.handleMove);
    this.surface.removeEventListener('pointerup', this.handleUp);
    this.surface.removeEventListener('pointercancel', this.handleCancel);
  }
}
