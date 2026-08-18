/**
 * Seating comes from the match, not from each client's view of the room.
 *
 * The bug this covers: seats were read from the room roster, which arrives
 * asynchronously and can still be empty when it is first looked at. A client
 * that looked too early fell back to seat 0 without anything noticing — and
 * when both clients did, both players stood on the same end of the range, saw
 * an identical view and dialled an identical elevation, in a game whose whole
 * premise is that the two archers stand at different heights.
 */

import { describe, expect, it } from 'vitest';

import { ARENAS } from '../src/arenas';
import { applyAction, archersFor, emptyMatch, replay, seatOfPlayer } from '../src/match';
import type { MatchAction, MatchState, Seat } from '../src/match';
import type { ArcherStats } from '../src/sim';

const P0 = 'player-0';
const P1 = 'player-1';
const STATS: ArcherStats = { maxHealth: 100, baseDamage: 25, headshotDamage: 60 };

/** A client whose roster never arrived: it can seat nobody on its own. */
const blindRoster = (): Seat | null => null;

function start(data: unknown, seatOf: (id: string) => Seat | null = blindRoster): MatchState {
  return applyAction(emptyMatch(), { playerId: P0, type: 'start', data, sequence: 1 } as MatchAction, seatOf);
}

describe('seating', () => {
  it('seats both players from the start action, with no roster at all', () => {
    const state = start({ arenaIndex: 0, players: [P0, P1], stats: [STATS, STATS] });
    expect(seatOfPlayer(state, P0)).toBe(0);
    expect(seatOfPlayer(state, P1)).toBe(1);
    expect(seatOfPlayer(state, 'someone-else')).toBeNull();
  });

  it('accepts a shot from the seated player even when the roster is blind', () => {
    // Seat 1 shoots first, and used to be rejected outright on a client that
    // could not resolve the shooter's seat.
    const state = start({ arenaIndex: 0, players: [P0, P1], stats: [STATS, STATS] });
    expect(state.turn).toBe(1);
    const shot = applyAction(
      state,
      { playerId: P1, type: 'shoot', data: { pitch: 0.3, power: 0.7 }, sequence: 2 } as MatchAction,
      blindRoster,
    );
    expect(shot.lastShot?.seat).toBe(1);
    expect(shot.turn).toBe(0);
  });

  it('falls back to the roster when a start carries no seating', () => {
    // Bot matches, and any client too old to send `players`.
    const roster = (id: string): Seat | null => (id === P0 ? 0 : id === P1 ? 1 : null);
    const state = start({ arenaIndex: 0, stats: [STATS, STATS] }, roster);
    expect(state.players).toBeNull();
    const shot = applyAction(
      state,
      { playerId: P1, type: 'shoot', data: { pitch: 0.3, power: 0.7 }, sequence: 2 } as MatchAction,
      roster,
    );
    expect(shot.lastShot?.seat).toBe(1);
  });

  it('rejects a seating record that cannot be trusted', () => {
    for (const players of [undefined, [], [P0], [P0, P0], [P0, ''], [1, 2]]) {
      const state = start({ arenaIndex: 0, players, stats: [STATS, STATS] });
      expect(state.players).toBeNull();
    }
  });

  it('survives a replay, which is how a rejoining client catches up', () => {
    const log: MatchAction[] = [
      { playerId: P0, type: 'start', data: { arenaIndex: 0, players: [P0, P1], stats: [STATS, STATS] }, sequence: 1 },
      { playerId: P1, type: 'shoot', data: { pitch: 0.3, power: 0.7 }, sequence: 2 },
    ];
    const state = replay(log, blindRoster);
    expect(seatOfPlayer(state, P1)).toBe(1);
    expect(state.lastShot?.seat).toBe(1);
  });

  it('puts the two archers at different heights in every arena', () => {
    // A level arena hides the mechanic the duel is built on, and arena 0 is
    // the only one a new player has unlocked.
    for (const arena of ARENAS) {
      const state = start({ arenaIndex: ARENAS.indexOf(arena), players: [P0, P1], stats: [STATS, STATS] });
      const [near, far] = archersFor(state);
      expect(Math.abs(near.pos.y - far.pos.y)).toBeGreaterThan(0.5);
    }
  });
});
