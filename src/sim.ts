/**
 * Deterministic ballistics + damage resolution.
 *
 * This module is the single source of truth for what a shot does. Both players
 * and the bot run the exact same function over the exact same inputs, so a shot
 * only has to travel the network as `{angle, power}` — never as a stream of
 * positions. Keep it pure: no Math.random, no Date.now, no DOM. Any randomness
 * must arrive as an explicit seed so every client reproduces it.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface ArcherStats {
  maxHealth: number;
  baseDamage: number;
  headshotDamage: number;
}

export interface ArcherState {
  pos: Vec2; // feet position, metres
  facing: 1 | -1;
  health: number;
  stats: ArcherStats;
}

/** Axis-aligned block that stops an arrow (castle merlon, rock, tree trunk). */
export interface Obstacle {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ArenaSpec {
  id: string;
  gravity: number; // m/s², positive magnitude
  wind: number; // m/s² horizontal, +x is toward player 1
  drag: number; // linear drag coefficient, 1/s
  spawn: [Vec2, Vec2];
  obstacles: Obstacle[];
}

export interface ShotInput {
  angle: number; // radians, measured from +x toward +y, already mirrored for facing
  power: number; // 0..1
}

export type HitZone = 'head' | 'body' | 'limb';

export interface ShotHit {
  target: 0 | 1;
  zone: HitZone;
  damage: number;
  point: Vec2;
}

export interface ShotResult {
  /** Sampled flight path used for rendering — always at least two points. */
  path: Vec2[];
  hit: ShotHit | null;
  blocked: boolean;
  flightTime: number;
}

/** Arrow speed at power = 1, in m/s. */
export const MAX_LAUNCH_SPEED = 34;
export const MIN_POWER = 0.2;
export const MIN_ANGLE = -0.35; // ≈ -20°
export const MAX_ANGLE = 1.45; // ≈ 83°

const DT = 1 / 120;
const MAX_FLIGHT_SECONDS = 12;
const GROUND_Y = 0;

/** Limb hits chip away far less than a clean body shot. */
const LIMB_MULTIPLIER = 0.55;

/**
 * Hit volumes, relative to the archer's feet. The sim is 2D in the XY plane;
 * the renderer places everything on the same Z so what the player sees is what
 * the sim resolves.
 */
const HEAD_CENTRE_Y = 1.62;
const HEAD_RADIUS = 0.19;
const BODY_TOP_Y = 1.45;
const BODY_BOTTOM_Y = 0.82;
const BODY_HALF_WIDTH = 0.3;
const LIMB_HALF_WIDTH = 0.26;

export function clampAngle(angle: number): number {
  return Math.min(MAX_ANGLE, Math.max(MIN_ANGLE, angle));
}

export function clampPower(power: number): number {
  return Math.min(1, Math.max(MIN_POWER, power));
}

/** World-space muzzle: roughly the archer's bow hand. */
export function muzzleOf(archer: ArcherState): Vec2 {
  return { x: archer.pos.x + archer.facing * 0.28, y: archer.pos.y + 1.32 };
}

function insideObstacle(o: Obstacle, p: Vec2): boolean {
  return p.x >= o.x && p.x <= o.x + o.w && p.y >= o.y && p.y <= o.y + o.h;
}

function hitZoneAt(archer: ArcherState, p: Vec2): HitZone | null {
  const dx = p.x - archer.pos.x;
  const dy = p.y - archer.pos.y;

  const hx = dx;
  const hy = dy - HEAD_CENTRE_Y;
  if (hx * hx + hy * hy <= HEAD_RADIUS * HEAD_RADIUS) return 'head';

  if (Math.abs(dx) <= BODY_HALF_WIDTH && dy >= BODY_BOTTOM_Y && dy <= BODY_TOP_Y) return 'body';

  // Legs below the torso and the drawing arm above it both count as limbs.
  if (Math.abs(dx) <= LIMB_HALF_WIDTH && dy >= 0 && dy < BODY_BOTTOM_Y) return 'limb';
  if (Math.abs(dx) <= LIMB_HALF_WIDTH && dy > BODY_TOP_Y && dy < HEAD_CENTRE_Y - HEAD_RADIUS) {
    return 'limb';
  }

  return null;
}

function damageFor(zone: HitZone, stats: ArcherStats): number {
  if (zone === 'head') return stats.headshotDamage;
  if (zone === 'body') return stats.baseDamage;
  return Math.round(stats.baseDamage * LIMB_MULTIPLIER);
}

/**
 * Fly one arrow and report what it hit.
 *
 * `shooter` is the index into `archers`; the other archer is the target. The
 * shooter's own hit volumes are ignored for the first few steps so an arrow
 * cannot spawn inside its owner.
 */
export function simulateShot(
  arena: ArenaSpec,
  archers: [ArcherState, ArcherState],
  shooter: 0 | 1,
  input: ShotInput,
): ShotResult {
  const shooterState = archers[shooter];
  const targetIndex: 0 | 1 = shooter === 0 ? 1 : 0;
  const targetState = archers[targetIndex];

  const angle = clampAngle(input.angle);
  const power = clampPower(input.power);
  const speed = MAX_LAUNCH_SPEED * power;

  const pos = muzzleOf(shooterState);
  let x = pos.x;
  let y = pos.y;
  let vx = Math.cos(angle) * speed * shooterState.facing;
  let vy = Math.sin(angle) * speed;

  const path: Vec2[] = [{ x, y }];
  let t = 0;

  while (t < MAX_FLIGHT_SECONDS) {
    // Semi-implicit Euler at a fixed step — identical on every machine.
    vx += (arena.wind - arena.drag * vx) * DT;
    vy += (-arena.gravity - arena.drag * vy) * DT;
    x += vx * DT;
    y += vy * DT;
    t += DT;

    const point: Vec2 = { x, y };
    path.push(point);

    if (y <= GROUND_Y) {
      return { path, hit: null, blocked: false, flightTime: t };
    }

    const zone = hitZoneAt(targetState, point);
    if (zone) {
      return {
        path,
        hit: {
          target: targetIndex,
          zone,
          damage: damageFor(zone, shooterState.stats),
          point,
        },
        blocked: false,
        flightTime: t,
      };
    }

    for (const obstacle of arena.obstacles) {
      if (insideObstacle(obstacle, point)) {
        return { path, hit: null, blocked: true, flightTime: t };
      }
    }

    // Off the sides of the world.
    if (x < -60 || x > 60 || y > 120) {
      return { path, hit: null, blocked: false, flightTime: t };
    }
  }

  return { path, hit: null, blocked: false, flightTime: t };
}

/**
 * Sample the first stretch of a shot without resolving hits — used to draw the
 * short aiming guide. Like the original game this hints at direction only; it
 * deliberately stops long before the target so elevation stays the player's job.
 */
export function previewPath(
  arena: ArenaSpec,
  shooter: ArcherState,
  input: ShotInput,
  seconds = 0.42,
): Vec2[] {
  const angle = clampAngle(input.angle);
  const power = clampPower(input.power);
  const speed = MAX_LAUNCH_SPEED * power;
  const start = muzzleOf(shooter);

  let x = start.x;
  let y = start.y;
  let vx = Math.cos(angle) * speed * shooter.facing;
  let vy = Math.sin(angle) * speed;

  const path: Vec2[] = [{ x, y }];
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i += 1) {
    vx += (arena.wind - arena.drag * vx) * DT;
    vy += (-arena.gravity - arena.drag * vy) * DT;
    x += vx * DT;
    y += vy * DT;
    if (y <= GROUND_Y) break;
    path.push({ x, y });
  }
  return path;
}
