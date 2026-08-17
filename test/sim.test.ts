import { describe, expect, it } from 'vitest';

import { ARENAS, arenaByIndex, highestUnlockedArena } from '../src/arenas';
import {
  MAX_LAUNCH_SPEED,
  MAX_PITCH,
  MAX_YAW,
  archersOf,
  facingOf,
  muzzleOf,
  pitchToDegrees,
  simulateShot,
} from '../src/sim';
import type { ArcherState, ArcherStats, ArenaSpec } from '../src/sim';

const STATS: ArcherStats = { maxHealth: 100, baseDamage: 20, headshotDamage: 50 };

const FLAT: ArenaSpec = {
  id: 'test',
  gravity: 9.81,
  wind: 0,
  drag: 0.05,
  range: 30,
  elevation: [0, 0],
  obstacles: [],
};

function archersFor(arena: ArenaSpec): [ArcherState, ArcherState] {
  return archersOf(arena, [STATS, STATS], [100, 100]);
}

/**
 * Search for a shot that lands on the given zone, so tests stay robust.
 *
 * Yaw is part of the search because crosswind blows every straight shot off
 * target in the later arenas — correcting for it is the player's job, and a
 * search that ignored it wrongly reported those arenas as unwinnable.
 */
function findShotHitting(
  arena: ArenaSpec,
  archers: [ArcherState, ArcherState],
  zone: string,
  shooter: 0 | 1 = 0,
) {
  for (let a = 0; a < 110; a += 1) {
    const pitch = -0.1 + (a / 110) * 0.85;
    for (let p = 0; p < 22; p += 1) {
      const power = 0.35 + (p / 22) * 0.65;
      for (let w = 0; w < 17; w += 1) {
        const yaw = -MAX_YAW + (w / 16) * MAX_YAW * 2;
        const input = { pitch, yaw, power };
        const result = simulateShot(arena, archers, shooter, input);
        if (result.hit?.zone === zone) return { input, result };
      }
    }
  }
  return null;
}

describe('simulateShot', () => {
  it('is deterministic — identical inputs give an identical outcome', () => {
    const archers = archersFor(FLAT);
    const input = { pitch: 0.22, yaw: 0.02, power: 0.82 };
    const a = simulateShot(FLAT, archers, 0, input);
    const b = simulateShot(FLAT, archers, 0, input);

    expect(a.path.length).toBe(b.path.length);
    expect(a.flightTime).toBe(b.flightTime);
    expect(a.hit).toEqual(b.hit);
    expect(a.path[a.path.length - 1]).toEqual(b.path[b.path.length - 1]);
  });

  it('starts the arrow at the shooter’s bow hand', () => {
    const archers = archersFor(FLAT);
    const result = simulateShot(FLAT, archers, 0, { pitch: 0.2, yaw: 0, power: 0.6 });
    expect(result.path[0]).toEqual(muzzleOf(archers[0], facingOf(0)));
  });

  it('sends seat 0 down-range and seat 1 back the other way', () => {
    const archers = archersFor(FLAT);
    const forward = simulateShot(FLAT, archers, 0, { pitch: 0.2, yaw: 0, power: 0.8 });
    const back = simulateShot(FLAT, archers, 1, { pitch: 0.2, yaw: 0, power: 0.8 });

    const endZ = (r: typeof forward) => r.path[r.path.length - 1].z;
    expect(endZ(forward)).toBeGreaterThan(0);
    expect(endZ(back)).toBeLessThan(FLAT.range);
  });

  it('drops a weak shot onto the ground short of the target', () => {
    const archers = archersFor(FLAT);
    const result = simulateShot(FLAT, archers, 0, { pitch: -0.1, yaw: 0, power: 0.21 });
    expect(result.hit).toBeNull();
    expect(result.path[result.path.length - 1].z).toBeLessThan(FLAT.range);
  });

  it('finds body, head and limb zones and pays out the matching damage', () => {
    const archers = archersFor(FLAT);

    const body = findShotHitting(FLAT, archers, 'body');
    expect(body).not.toBeNull();
    expect(body!.result.hit!.damage).toBe(STATS.baseDamage);

    const head = findShotHitting(FLAT, archers, 'head');
    expect(head).not.toBeNull();
    expect(head!.result.hit!.damage).toBe(STATS.headshotDamage);

    const limb = findShotHitting(FLAT, archers, 'limb');
    expect(limb).not.toBeNull();
    expect(limb!.result.hit!.damage).toBeLessThan(STATS.baseDamage);
  });

  it('always attributes the hit to the opponent, never the shooter', () => {
    const archers = archersFor(FLAT);
    expect(findShotHitting(FLAT, archers, 'body', 0)!.result.hit!.target).toBe(1);
    expect(findShotHitting(FLAT, archers, 'body', 1)!.result.hit!.target).toBe(0);
  });

  it('stops an arrow on an obstacle instead of letting it through', () => {
    const archers = archersFor(FLAT);
    const open = findShotHitting(FLAT, archers, 'body')!;

    const walled: ArenaSpec = {
      ...FLAT,
      obstacles: [{ x: -6, y: 0, z: 14, w: 12, h: 14, d: 2 }],
    };
    const blocked = simulateShot(walled, archers, 0, open.input);

    expect(blocked.blocked).toBe(true);
    expect(blocked.hit).toBeNull();
  });

  it('lets crosswind push the arrow sideways', () => {
    const archers = archersFor(FLAT);
    const input = { pitch: 0.25, yaw: 0, power: 0.8 };
    const calm = simulateShot(FLAT, archers, 0, input);
    const gale = simulateShot({ ...FLAT, wind: 8 }, archers, 0, input);

    const endX = (r: typeof calm) => r.path[r.path.length - 1].x;
    expect(endX(gale)).toBeGreaterThan(endX(calm) + 0.5);
  });

  it('lets yaw aim off to the side, which is how wind gets corrected', () => {
    const archers = archersFor(FLAT);
    const straight = simulateShot(FLAT, archers, 0, { pitch: 0.25, yaw: 0, power: 0.8 });
    const right = simulateShot(FLAT, archers, 0, { pitch: 0.25, yaw: 0.12, power: 0.8 });

    const endX = (r: typeof straight) => r.path[r.path.length - 1].x;
    expect(endX(right)).toBeGreaterThan(endX(straight));
  });

  it('clamps absurd inputs rather than flying forever', () => {
    const archers = archersFor(FLAT);
    const result = simulateShot(FLAT, archers, 0, { pitch: 99, yaw: 99, power: 99 });
    expect(result.flightTime).toBeLessThanOrEqual(14);
    expect(Number.isFinite(result.path[result.path.length - 1].z)).toBe(true);
  });

  it('keeps launch speed proportional to power', () => {
    const archers = archersFor(FLAT);
    const slow = simulateShot(FLAT, archers, 0, { pitch: 0.3, yaw: 0, power: 0.4 });
    const fast = simulateShot(FLAT, archers, 0, { pitch: 0.3, yaw: 0, power: 1 });
    expect(fast.path.length).toBeGreaterThan(slow.path.length);
    expect(MAX_LAUNCH_SPEED).toBeGreaterThan(0);
  });

  it('reports elevation in whole degrees for the gauge', () => {
    expect(pitchToDegrees(0)).toBe(0);
    expect(pitchToDegrees(Math.PI / 6)).toBe(30);
    expect(pitchToDegrees(MAX_PITCH)).toBeLessThanOrEqual(46);
  });
});

describe('arenas', () => {
  it('ships five arenas that get longer and harder in order', () => {
    expect(ARENAS).toHaveLength(5);
    for (let i = 1; i < ARENAS.length; i += 1) {
      expect(ARENAS[i].unlockRating).toBeGreaterThan(ARENAS[i - 1].unlockRating);
      expect(ARENAS[i].botSkill).toBeGreaterThan(ARENAS[i - 1].botSkill);
      expect(ARENAS[i].range).toBeGreaterThan(ARENAS[i - 1].range);
    }
    expect(arenaByIndex(-5)).toBe(ARENAS[0]);
    expect(arenaByIndex(99)).toBe(ARENAS[ARENAS.length - 1]);
  });

  it('unlocks arenas by rating', () => {
    expect(highestUnlockedArena(0)).toBe(0);
    expect(highestUnlockedArena(999)).toBe(0);
    expect(highestUnlockedArena(ARENAS[2].unlockRating)).toBe(2);
    expect(highestUnlockedArena(99999)).toBe(ARENAS.length - 1);
  });

  it('gives every arena a reachable target from both ends', () => {
    // A ladder step nobody can hit would be an unwinnable dead end.
    for (const arena of ARENAS) {
      const archers = archersFor(arena);
      expect(findShotHitting(arena, archers, 'body', 0)).not.toBeNull();
      expect(findShotHitting(arena, archers, 'body', 1)).not.toBeNull();
    }
  });

  it('keeps every arena inside the elevation the gauge can show', () => {
    for (const arena of ARENAS) {
      const archers = archersFor(arena);
      const shot = findShotHitting(arena, archers, 'body', 0)!;
      expect(shot.input.pitch).toBeLessThanOrEqual(MAX_PITCH);
    }
  });
});
