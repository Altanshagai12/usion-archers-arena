import { describe, expect, it } from 'vitest';

import { startPlan } from '../src/handshake';
import type { ArcherStats } from '../src/sim';

const mine: ArcherStats = { maxHealth: 120, baseDamage: 30, headshotDamage: 60 };
const theirs: ArcherStats = { maxHealth: 100, baseDamage: 25, headshotDamage: 50 };

const announced = (entries: Array<[string, ArcherStats]>): Map<string, ArcherStats> =>
  new Map(entries);

describe('startPlan', () => {
  it('starts once the peer has announced, without waiting for our own echo', () => {
    // The regression: an embedded action has no acknowledgement, so our own
    // `ready` may never come back. That must not hold up the match.
    const plan = startPlan(['me', 'you'], 'me', mine, announced([['you', theirs]]));
    expect(plan).toEqual({ players: ['me', 'you'], stats: [mine, theirs] });
  });

  it('waits while the peer has not announced', () => {
    expect(startPlan(['me', 'you'], 'me', mine, announced([['me', mine]]))).toBeNull();
  });

  it('only the first seat starts the match', () => {
    // Both clients run this on every roster change and every `ready`; if the
    // second seat started too, two `start` actions would race.
    const roster = ['you', 'me'];
    const heard = announced([['you', theirs]]);
    expect(startPlan(roster, 'me', mine, heard)).toBeNull();
    expect(startPlan(roster, 'you', theirs, announced([['me', mine]]))).toEqual({
      players: ['you', 'me'],
      stats: [theirs, mine],
    });
  });

  it('waits for a full room', () => {
    expect(startPlan(['me'], 'me', mine, announced([]))).toBeNull();
    expect(startPlan([], 'me', mine, announced([]))).toBeNull();
  });

  it('reads our own stats for our seat even when a stale echo disagrees', () => {
    // A nudge re-announces, so the relay can hold an older copy of our stats.
    // The live profile is the truth for our own seat.
    const stale: ArcherStats = { maxHealth: 1, baseDamage: 1, headshotDamage: 1 };
    const plan = startPlan(
      ['me', 'you'],
      'me',
      mine,
      announced([
        ['me', stale],
        ['you', theirs],
      ]),
    );
    expect(plan).toEqual({ players: ['me', 'you'], stats: [mine, theirs] });
  });

  it('is repeatable, so a nudge can keep asking', () => {
    const heard = announced([['you', theirs]]);
    const first = startPlan(['me', 'you'], 'me', mine, heard);
    const second = startPlan(['me', 'you'], 'me', mine, heard);
    expect(first).toEqual(second);
  });
});
