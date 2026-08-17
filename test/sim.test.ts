import { describe, expect, it } from 'vitest';

import { ARENAS, arenaByIndex, highestUnlockedArena } from '../src/arenas';
import { MAX_LAUNCH_SPEED, muzzleOf, simulateShot } from '../src/sim';
import type { ArcherState, ArcherStats, ArenaSpec } from '../src/sim';

const STATS: ArcherStats = { maxHealth: 100, baseDamage: 20, headshotDamage: 50 };

function archersAt(leftX: number, rightX: number, rightY = 0): [ArcherState, ArcherState] {
  return [
    { pos: { x: leftX, y: 0 }, facing: 1, health: 100, stats: STATS },
    { pos: { x: rightX, y: rightY }, facing: -1, health: 100, stats: STATS },
  ];
}

const FLAT: ArenaSpec = {
  id: 'test',
  gravity: 9.81,
  wind: 0,
  drag: 0.045,
  spawn: [
    { x: -9, y: 0 },
    { x: 9, y: 0 },
  ],
  obstacles: [],
};

/** Search for a shot that lands on the given zone, so tests stay robust. */
function findShotHitting(arena: ArenaSpec, archers: [ArcherState, ArcherState], zone: string) {
  for (let a = 0; a < 400; a += 1) {
    const angle = -0.2 + (a / 400) * 1.5;
    for (let p = 0; p < 60; p += 1) {
      const power = 0.3 + (p / 60) * 0.7;
      const result = simulateShot(arena, archers, 0, { angle, power });
      if (result.hit?.zone === zone) return { angle, power, result };
    }
  }
  return null;
}

describe('simulateShot', () => {
  it('is deterministic — identical inputs give an identical outcome', () => {
    const archers = archersAt(-9, 9);
    const input = { angle: 0.55, power: 0.82 };
    const a = simulateShot(FLAT, archers, 0, input);
    const b = simulateShot(FLAT, archers, 0, input);

    expect(a.path.length).toBe(b.path.length);
    expect(a.flightTime).toBe(b.flightTime);
    expect(a.hit).toEqual(b.hit);
    expect(a.path[a.path.length - 1]).toEqual(b.path[b.path.length - 1]);
  });

  it('starts the arrow at the shooter’s bow hand', () => {
    const archers = archersAt(-9, 9);
    const result = simulateShot(FLAT, archers, 0, { angle: 0.5, power: 0.6 });
    expect(result.path[0]).toEqual(muzzleOf(archers[0]));
  });

  it('drops a weak shot onto the ground short of the target', () => {
    const archers = archersAt(-9, 9);
    const result = simulateShot(FLAT, archers, 0, { angle: 0.1, power: 0.21 });
    expect(result.hit).toBeNull();
    expect(result.blocked).toBe(false);
    expect(result.path[result.path.length - 1].x).toBeLessThan(9);
  });

  it('finds body, head and limb zones and pays out the matching damage', () => {
    const archers = archersAt(-9, 9);

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
    const archers = archersAt(-9, 9);
    const shot = findShotHitting(FLAT, archers, 'body')!;
    expect(shot.result.hit!.target).toBe(1);

    const fromTheRight = simulateShot(FLAT, archers, 1, {
      angle: shot.angle,
      power: shot.power,
    });
    if (fromTheRight.hit) expect(fromTheRight.hit.target).toBe(0);
  });

  it('stops an arrow on an obstacle instead of letting it through', () => {
    const archers = archersAt(-9, 9);
    const open = findShotHitting(FLAT, archers, 'body')!;

    const walled: ArenaSpec = { ...FLAT, obstacles: [{ x: -1, y: 0, w: 2, h: 12 }] };
    const blocked = simulateShot(walled, archers, 0, { angle: open.angle, power: open.power });

    expect(blocked.blocked).toBe(true);
    expect(blocked.hit).toBeNull();
  });

  it('lets wind bend the flight', () => {
    const archers = archersAt(-9, 9);
    const input = { angle: 0.7, power: 0.75 };
    const calm = simulateShot(FLAT, archers, 0, input);
    const gale = simulateShot({ ...FLAT, wind: 6 }, archers, 0, input);

    const endOf = (r: typeof calm) => r.path[r.path.length - 1].x;
    expect(endOf(gale)).toBeGreaterThan(endOf(calm));
  });

  it('clamps absurd inputs rather than flying forever', () => {
    const archers = archersAt(-9, 9);
    const result = simulateShot(FLAT, archers, 0, { angle: 99, power: 99 });
    expect(result.flightTime).toBeLessThanOrEqual(12);
    expect(Number.isFinite(result.path[result.path.length - 1].x)).toBe(true);
  });

  it('keeps launch speed proportional to power', () => {
    const archers = archersAt(-9, 9);
    const slow = simulateShot(FLAT, archers, 0, { angle: 0.7, power: 0.4 });
    const fast = simulateShot(FLAT, archers, 0, { angle: 0.7, power: 1 });
    expect(fast.path.length).toBeGreaterThan(slow.path.length);
    expect(MAX_LAUNCH_SPEED).toBeGreaterThan(0);
  });
});

describe('arenas', () => {
  it('ships five arenas in ascending unlock order', () => {
    expect(ARENAS).toHaveLength(5);
    for (let i = 1; i < ARENAS.length; i += 1) {
      expect(ARENAS[i].unlockRating).toBeGreaterThan(ARENAS[i - 1].unlockRating);
      expect(ARENAS[i].botSkill).toBeGreaterThan(ARENAS[i - 1].botSkill);
    }
  });

  it('places the two archers apart and clamps out-of-range indexes', () => {
    for (const arena of ARENAS) {
      expect(Math.abs(arena.spawn[0].x - arena.spawn[1].x)).toBeGreaterThan(10);
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

  it('gives every arena a target its own bot can actually reach', () => {
    // A ladder step nobody can hit would be an unwinnable dead end.
    for (const arena of ARENAS) {
      const archers: [ArcherState, ArcherState] = [
        { pos: arena.spawn[0], facing: 1, health: 100, stats: STATS },
        { pos: arena.spawn[1], facing: -1, health: 100, stats: STATS },
      ];
      expect(findShotHitting(arena, archers, 'body')).not.toBeNull();
    }
  });
});
