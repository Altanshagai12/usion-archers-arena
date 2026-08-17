/**
 * Deterministic 3D ballistics + damage resolution.
 *
 * The game is played down-range from behind the archer, so the sim is fully 3D:
 *
 *   z — distance down-range. The shooter stands at z = 0, the target at z = +D.
 *   y — height above the ground.
 *   x — lateral. Wind pushes along it and the player aims across it (windage).
 *
 * Both players and the bot run this same function over the same inputs, so a
 * shot only travels the network as `{pitch, yaw, power}`. Keep it pure: no
 * Math.random, no Date.now, no DOM.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface ArcherStats {
  maxHealth: number;
  baseDamage: number;
  headshotDamage: number;
}

export interface ArcherState {
  /** Feet position. The local archer is at z = 0; the opponent down-range. */
  pos: Vec3;
  health: number;
  stats: ArcherStats;
}

/** A box that stops an arrow — hay bales, fence posts, rocks. */
export interface Obstacle {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
}

export interface ArenaSpec {
  id: string;
  gravity: number;
  /** Lateral wind acceleration, m/s². Positive pushes arrows to the right. */
  wind: number;
  drag: number;
  /** Down-range distance between the two archers, metres. */
  range: number;
  /** Height of each firing position — the opponent may stand higher or lower. */
  elevation: [number, number];
  obstacles: Obstacle[];
}

export interface ShotInput {
  /** Elevation above horizontal, radians. This is the number the gauge shows. */
  pitch: number;
  /** Lateral aim, radians. Positive aims right. */
  yaw: number;
  /** Draw strength, 0..1. */
  power: number;
}

export type HitZone = 'head' | 'body' | 'limb';

export interface ShotHit {
  target: 0 | 1;
  zone: HitZone;
  damage: number;
  point: Vec3;
}

export interface ShotResult {
  /** Sampled flight path used for rendering — always at least two points. */
  path: Vec3[];
  hit: ShotHit | null;
  blocked: boolean;
  flightTime: number;
}

/** Arrow speed at power = 1, in m/s. */
export const MAX_LAUNCH_SPEED = 46;
export const MIN_POWER = 0.2;
export const MIN_PITCH = -0.14; // ≈ -8°
export const MAX_PITCH = 0.79; // ≈ 45°
export const MAX_YAW = 0.14; // ≈ ±8°

const DT = 1 / 120;
const MAX_FLIGHT_SECONDS = 14;
const GROUND_Y = 0;

const LIMB_MULTIPLIER = 0.55;

/** Hit volumes, relative to the target's feet. */
const HEAD_CENTRE_Y = 1.62;
const HEAD_RADIUS = 0.2;
const BODY_TOP_Y = 1.45;
const BODY_BOTTOM_Y = 0.82;
const BODY_HALF_WIDTH = 0.3;
const BODY_HALF_DEPTH = 0.24;
const LIMB_HALF_WIDTH = 0.28;

/** Bow hand, relative to the shooter's feet. */
const MUZZLE_UP = 1.5;
const MUZZLE_SIDE = 0.16;

export function clampPitch(pitch: number): number {
  return Math.min(MAX_PITCH, Math.max(MIN_PITCH, pitch));
}

export function clampYaw(yaw: number): number {
  return Math.min(MAX_YAW, Math.max(-MAX_YAW, yaw));
}

export function clampPower(power: number): number {
  return Math.min(1, Math.max(MIN_POWER, power));
}

/** Degrees, for the elevation gauge. */
export function pitchToDegrees(pitch: number): number {
  return Math.round((pitch * 180) / Math.PI);
}

export function muzzleOf(archer: ArcherState, facing: 1 | -1): Vec3 {
  return {
    x: archer.pos.x + MUZZLE_SIDE * facing,
    y: archer.pos.y + MUZZLE_UP,
    z: archer.pos.z,
  };
}

/** Seat 0 shoots toward +z, seat 1 back toward -z. */
export function facingOf(shooter: 0 | 1): 1 | -1 {
  return shooter === 0 ? 1 : -1;
}

function insideObstacle(o: Obstacle, p: Vec3): boolean {
  return (
    p.x >= o.x &&
    p.x <= o.x + o.w &&
    p.y >= o.y &&
    p.y <= o.y + o.h &&
    p.z >= o.z &&
    p.z <= o.z + o.d
  );
}

/**
 * Test the segment an arrow covered this step against the target, not the end
 * point.
 *
 * An arrow moves ~0.4 m per step while the torso is 0.48 m deep and the head
 * 0.4 m across, so a point test tunnels straight through a target it should
 * have hit — which made whole arenas unwinnable. Instead, find where the
 * segment crosses the target's plane and test that crossing in 2D.
 */
function hitOnSegment(archer: ArcherState, a: Vec3, b: Vec3): HitZone | null {
  const tz = archer.pos.z;
  const da = a.z - tz;
  const db = b.z - tz;

  // Only consider the step that straddles (or touches) the target's plane.
  if (da * db > 0 && Math.min(Math.abs(da), Math.abs(db)) > BODY_HALF_DEPTH) return null;

  const denom = b.z - a.z;
  const t = Math.abs(denom) < 1e-9 ? 0 : (tz - a.z) / denom;
  if (t < -0.001 || t > 1.001) return null;

  const clamped = Math.min(1, Math.max(0, t));
  const p: Vec3 = {
    x: a.x + (b.x - a.x) * clamped,
    y: a.y + (b.y - a.y) * clamped,
    z: tz,
  };
  return zoneAtPlane(archer, p);
}

function zoneAtPlane(archer: ArcherState, p: Vec3): HitZone | null {
  const dx = p.x - archer.pos.x;
  const dy = p.y - archer.pos.y;

  const hy = dy - HEAD_CENTRE_Y;
  if (dx * dx + hy * hy <= HEAD_RADIUS * HEAD_RADIUS) return 'head';

  if (Math.abs(dx) <= BODY_HALF_WIDTH && dy >= BODY_BOTTOM_Y && dy <= BODY_TOP_Y) {
    return 'body';
  }

  // Legs below the torso, and the arms out to either side of it.
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

/** Build the two archer states an arena implies. */
export function archersOf(
  arena: ArenaSpec,
  stats: [ArcherStats, ArcherStats],
  health: [number, number],
): [ArcherState, ArcherState] {
  return [
    { pos: { x: 0, y: arena.elevation[0], z: 0 }, health: health[0], stats: stats[0] },
    { pos: { x: 0, y: arena.elevation[1], z: arena.range }, health: health[1], stats: stats[1] },
  ];
}

/**
 * Fly one arrow and report what it hit.
 *
 * `shooter` indexes `archers`; the other archer is the target. Ground level is
 * y = 0 everywhere, so an archer standing on a mound is simply higher up.
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
  const facing = facingOf(shooter);

  const pitch = clampPitch(input.pitch);
  const yaw = clampYaw(input.yaw);
  const power = clampPower(input.power);
  const speed = MAX_LAUNCH_SPEED * power;

  const start = muzzleOf(shooterState, facing);
  let { x, y, z } = start;

  const horizontal = Math.cos(pitch) * speed;
  let vx = Math.sin(yaw) * horizontal * facing;
  let vy = Math.sin(pitch) * speed;
  let vz = Math.cos(yaw) * horizontal * facing;

  const path: Vec3[] = [{ x, y, z }];
  let t = 0;
  let previous: Vec3 = { x, y, z };

  while (t < MAX_FLIGHT_SECONDS) {
    // Semi-implicit Euler at a fixed step — identical on every machine.
    vx += (arena.wind - arena.drag * vx) * DT;
    vy += (-arena.gravity - arena.drag * vy) * DT;
    vz += -arena.drag * vz * DT;
    x += vx * DT;
    y += vy * DT;
    z += vz * DT;
    t += DT;

    const point: Vec3 = { x, y, z };
    path.push(point);

    // Check the target before the ground: an arrow that clips the target on
    // the same step it lands still counts as a hit.
    const zone = hitOnSegment(targetState, previous, point);
    if (zone) {
      return {
        path,
        hit: { target: targetIndex, zone, damage: damageFor(zone, shooterState.stats), point },
        blocked: false,
        flightTime: t,
      };
    }

    if (y <= GROUND_Y) {
      return { path, hit: null, blocked: false, flightTime: t };
    }

    for (const obstacle of arena.obstacles) {
      if (insideObstacle(obstacle, point)) {
        return { path, hit: null, blocked: true, flightTime: t };
      }
    }

    if (Math.abs(x) > 60 || y > 140 || z < -25 || z > arena.range + 30) {
      return { path, hit: null, blocked: false, flightTime: t };
    }

    previous = point;
  }

  return { path, hit: null, blocked: false, flightTime: t };
}

/**
 * Sample the opening of a shot without resolving hits — the short aiming
 * tracer. Like the original it hints at direction only; it stops well short of
 * the target so judging the drop stays the player's job.
 */
export function previewPath(
  arena: ArenaSpec,
  shooter: ArcherState,
  facing: 1 | -1,
  input: ShotInput,
  seconds = 0.32,
): Vec3[] {
  const pitch = clampPitch(input.pitch);
  const yaw = clampYaw(input.yaw);
  const power = clampPower(input.power);
  const speed = MAX_LAUNCH_SPEED * power;
  const start = muzzleOf(shooter, facing);

  let { x, y, z } = start;
  const horizontal = Math.cos(pitch) * speed;
  let vx = Math.sin(yaw) * horizontal * facing;
  let vy = Math.sin(pitch) * speed;
  let vz = Math.cos(yaw) * horizontal * facing;

  const path: Vec3[] = [{ x, y, z }];
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i += 1) {
    vx += (arena.wind - arena.drag * vx) * DT;
    vy += (-arena.gravity - arena.drag * vy) * DT;
    vz += -arena.drag * vz * DT;
    x += vx * DT;
    y += vy * DT;
    z += vz * DT;
    if (y <= GROUND_Y) break;
    path.push({ x, y, z });
  }
  return path;
}
