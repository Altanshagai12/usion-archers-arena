import { describe, expect, it } from 'vitest';

import { arenaByIndex } from '../src/arenas';
import { chooseBotShot, createBotMemory } from '../src/bot';
import { applyAction, archersFor, emptyMatch, replay } from '../src/match';
import type { MatchAction, MatchState, Seat } from '../src/match';
import { MAX_PITCH, simulateShot } from '../src/sim';
import type { ArcherStats } from '../src/sim';

const P0 = 'player-0';
const P1 = 'player-1';
const seatOf = (id: string): Seat | null => (id === P0 ? 0 : id === P1 ? 1 : null);

const STATS: ArcherStats = { maxHealth: 100, baseDamage: 25, headshotDamage: 60 };

let sequence = 0;
function act(state: MatchState, playerId: string, type: string, data?: unknown): MatchState {
  sequence += 1;
  return applyAction(state, { playerId, type, data, sequence } as MatchAction, seatOf);
}

function started(arenaIndex = 0): MatchState {
  sequence = 0;
  return act(emptyMatch(), P0, 'start', { arenaIndex, stats: [STATS, STATS] });
}

/** A shot from `seat` that is guaranteed to land on the opponent's body. */
function killerShot(state: MatchState, seat: Seat) {
  const arena = arenaByIndex(state.arenaIndex);
  const archers = archersFor(state);
  for (let a = 0; a < 110; a += 1) {
    const pitch = -0.1 + (a / 110) * 0.85;
    for (let p = 0; p < 22; p += 1) {
      const power = 0.35 + (p / 22) * 0.65;
      const input = { pitch, power };
      if (simulateShot(arena, archers, seat, input).hit?.zone === 'body') return input;
    }
  }
  throw new Error('no body shot found');
}

describe('match reducer', () => {
  it('starts both archers at full health with seat 1 to shoot', () => {
    const state = started();
    expect(state.started).toBe(true);
    expect(state.health).toEqual([STATS.maxHealth, STATS.maxHealth]);
    expect(state.turn).toBe(1);
    expect(state.over).toBe(false);
  });

  it('ignores a shot from the player whose turn it is not', () => {
    const state = started();
    const after = act(state, P0, 'shoot', killerShot(state, 0));
    expect(after.health).toEqual(state.health);
    expect(after.turn).toBe(1);
    expect(after.lastShot).toBeNull();
  });

  it('applies damage and passes the turn', () => {
    let state = started();
    state = act(state, P1, 'shoot', killerShot(state, 1));

    expect(state.health[0]).toBe(STATS.maxHealth - STATS.baseDamage);
    expect(state.health[1]).toBe(STATS.maxHealth);
    expect(state.turn).toBe(0);
    expect(state.lastShot?.zone).toBe('body');
    expect(state.lastShot?.seat).toBe(1);
  });

  it('ends the match when health reaches zero and names the other seat winner', () => {
    let state = started();
    let guard = 0;
    while (!state.over && guard < 40) {
      const seat = state.turn;
      state = act(state, seat === 0 ? P0 : P1, 'shoot', killerShot(state, seat));
      guard += 1;
    }
    expect(state.over).toBe(true);
    expect(state.winner).not.toBeNull();
    expect(state.health[state.winner === 0 ? 1 : 0]).toBe(0);
    // 100 HP at 25 a hit — a duel is several exchanges, never one shot.
    expect(guard).toBeGreaterThan(4);
  });

  it('refuses further shots once the match is over', () => {
    let state = started();
    let guard = 0;
    while (!state.over && guard < 40) {
      const seat = state.turn;
      state = act(state, seat === 0 ? P0 : P1, 'shoot', killerShot(state, seat));
      guard += 1;
    }
    const frozen = act(state, P0, 'shoot', { pitch: 0.3, power: 0.9 });
    expect(frozen.health).toEqual(state.health);
    expect(frozen.winner).toBe(state.winner);
  });

  it('drops replayed or out-of-order sequences instead of double-applying', () => {
    let state = started();
    const shot = killerShot(state, 1);
    const action: MatchAction = { playerId: P1, type: 'shoot', data: shot, sequence: 50 };

    state = applyAction(state, action, seatOf);
    const health = [...state.health];

    expect(applyAction(state, action, seatOf).health).toEqual(health);
    expect(applyAction(state, { ...action, sequence: 12 }, seatOf).health).toEqual(health);
  });

  it('replays an action log to exactly the same state', () => {
    sequence = 0;
    const log: MatchAction[] = [];
    let live = emptyMatch();

    const push = (playerId: string, type: string, data?: unknown): void => {
      sequence += 1;
      const action = { playerId, type, data, sequence } as MatchAction;
      log.push(action);
      live = applyAction(live, action, seatOf);
    };

    push(P0, 'start', { arenaIndex: 1, stats: [STATS, STATS] });
    for (let i = 0; i < 4 && !live.over; i += 1) {
      const seat = live.turn;
      push(seat === 0 ? P0 : P1, 'shoot', killerShot(live, seat));
    }

    expect(replay(log, seatOf)).toEqual(live);
    // Shuffled delivery must not change the outcome.
    expect(replay([...log].reverse(), seatOf)).toEqual(live);
  });

  it('treats a forfeit as a win for the other seat', () => {
    const state = act(started(), P1, 'forfeit', {});
    expect(state.over).toBe(true);
    expect(state.winner).toBe(0);
  });

  it('clamps hostile stats from a tampered client', () => {
    sequence = 0;
    const state = act(emptyMatch(), P0, 'start', {
      arenaIndex: 0,
      stats: [{ maxHealth: 1e9, baseDamage: 1e9, headshotDamage: 1e9 }, STATS],
    });
    expect(state.stats[0].maxHealth).toBeLessThanOrEqual(400);
    expect(state.stats[0].baseDamage).toBeLessThanOrEqual(120);
    expect(state.stats[0].headshotDamage).toBeLessThanOrEqual(260);
  });
});

describe('bot', () => {
  it('returns a shot inside the legal aim range', () => {
    const state = started();
    const arena = arenaByIndex(0);
    const memory = createBotMemory();
    for (let i = 0; i < 20; i += 1) {
      const shot = chooseBotShot(arena, archersFor(state), 1, arena.botSkill, memory);
      expect(shot.power).toBeGreaterThanOrEqual(0.2);
      expect(shot.power).toBeLessThanOrEqual(1);
      expect(shot.pitch).toBeLessThanOrEqual(MAX_PITCH);
    }
  });

  it('hits more often as skill rises — the ladder actually gets harder', () => {
    const state = started();
    const arena = arenaByIndex(0);
    const archers = archersFor(state);

    const hitRate = (skill: number): number => {
      let hits = 0;
      const rounds = 120;
      for (let i = 0; i < rounds; i += 1) {
        const memory = createBotMemory();
        memory.shotsTaken = 3; // past the warm-up, measuring steady-state aim
        const shot = chooseBotShot(arena, archers, 1, skill, memory);
        if (simulateShot(arena, archers, 1, shot).hit) hits += 1;
      }
      return hits / rounds;
    };

    const weak = hitRate(0.3);
    const strong = hitRate(0.95);
    expect(strong).toBeGreaterThan(weak + 0.1);
    expect(weak).toBeGreaterThan(0);
  });
});
