/**
 * The match as a pure reducer over an ordered action log.
 *
 * Every client — and every client that rejoins mid-match — folds the same
 * actions in the same order and lands on the same state, so a shot only has to
 * cross the network as `{angle, power}`. Nothing in here may touch the DOM,
 * the network, the clock or randomness.
 */

import { arenaByIndex } from './arenas';
import { simulateShot } from './sim';
import type { ArcherState, ArcherStats, HitZone, ShotInput } from './sim';

export type Seat = 0 | 1;

export interface ResolvedShot {
  seat: Seat;
  input: ShotInput;
  zone: HitZone | null;
  damage: number;
  blocked: boolean;
  /** Sequence of the action that produced it — used to fire the animation once. */
  sequence: number;
}

export interface MatchState {
  started: boolean;
  arenaIndex: number;
  stats: [ArcherStats, ArcherStats];
  health: [number, number];
  turn: Seat;
  over: boolean;
  winner: Seat | null;
  lastShot: ResolvedShot | null;
  /** Highest action sequence folded in — keeps replays idempotent. */
  appliedSequence: number;
}

export interface MatchAction {
  playerId: string;
  type: string;
  data: any;
  sequence: number;
}

const FALLBACK_STATS: ArcherStats = { maxHealth: 100, baseDamage: 18, headshotDamage: 45 };

export function emptyMatch(): MatchState {
  return {
    started: false,
    arenaIndex: 0,
    stats: [FALLBACK_STATS, FALLBACK_STATS],
    health: [FALLBACK_STATS.maxHealth, FALLBACK_STATS.maxHealth],
    turn: 0,
    over: false,
    winner: null,
    lastShot: null,
    appliedSequence: 0,
  };
}

function sanitiseStats(raw: any): ArcherStats {
  const number = (value: any, fallback: number, min: number, max: number): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.round(parsed)));
  };
  return {
    maxHealth: number(raw?.maxHealth, FALLBACK_STATS.maxHealth, 60, 400),
    baseDamage: number(raw?.baseDamage, FALLBACK_STATS.baseDamage, 5, 120),
    headshotDamage: number(raw?.headshotDamage, FALLBACK_STATS.headshotDamage, 10, 260),
  };
}

/** Live archer states derived from the match — positions come from the arena. */
export function archersFor(state: MatchState): [ArcherState, ArcherState] {
  const arena = arenaByIndex(state.arenaIndex);
  return [
    {
      pos: arena.spawn[0],
      facing: 1,
      health: state.health[0],
      stats: state.stats[0],
    },
    {
      pos: arena.spawn[1],
      facing: -1,
      health: state.health[1],
      stats: state.stats[1],
    },
  ];
}

/**
 * Fold one action. Unknown or out-of-turn actions are ignored rather than
 * throwing — a late or duplicated message must never desync a client.
 */
export function applyAction(
  state: MatchState,
  action: MatchAction,
  seatOf: (playerId: string) => Seat | null,
): MatchState {
  if (action.sequence <= state.appliedSequence) return state;
  const next: MatchState = { ...state, appliedSequence: action.sequence };

  if (action.type === 'start') {
    const arenaIndex = Math.max(0, Math.floor(Number(action.data?.arenaIndex) || 0));
    const stats: [ArcherStats, ArcherStats] = [
      sanitiseStats(action.data?.stats?.[0]),
      sanitiseStats(action.data?.stats?.[1]),
    ];
    return {
      ...next,
      started: true,
      arenaIndex,
      stats,
      health: [stats[0].maxHealth, stats[1].maxHealth],
      // The player who did NOT set up the match shoots first — a small
      // courtesy that also stops the host from having a first-strike edge.
      turn: 1,
      over: false,
      winner: null,
      lastShot: null,
    };
  }

  if (action.type === 'shoot') {
    if (!next.started || next.over) return next;

    const seat = seatOf(action.playerId);
    if (seat === null || seat !== next.turn) return next;

    const input: ShotInput = {
      angle: Number(action.data?.angle) || 0,
      power: Number(action.data?.power) || 0,
    };
    const arena = arenaByIndex(next.arenaIndex);
    const result = simulateShot(arena, archersFor(next), seat, input);

    const health: [number, number] = [next.health[0], next.health[1]];
    let zone: HitZone | null = null;
    let damage = 0;

    if (result.hit) {
      zone = result.hit.zone;
      damage = result.hit.damage;
      const target = result.hit.target;
      health[target] = Math.max(0, health[target] - damage);
    }

    const loser: Seat | null = health[0] <= 0 ? 0 : health[1] <= 0 ? 1 : null;

    return {
      ...next,
      health,
      turn: seat === 0 ? 1 : 0,
      over: loser !== null,
      winner: loser === null ? null : loser === 0 ? 1 : 0,
      lastShot: {
        seat,
        input,
        zone,
        damage,
        blocked: result.blocked,
        sequence: action.sequence,
      },
    };
  }

  if (action.type === 'forfeit') {
    const seat = seatOf(action.playerId);
    if (seat === null || next.over) return next;
    return { ...next, over: true, winner: seat === 0 ? 1 : 0 };
  }

  return next;
}

/** Rebuild from scratch — used on reconnect sync. */
export function replay(
  actions: MatchAction[],
  seatOf: (playerId: string) => Seat | null,
): MatchState {
  const ordered = [...actions].sort((a, b) => a.sequence - b.sequence);
  let state = emptyMatch();
  for (const action of ordered) state = applyAction(state, action, seatOf);
  return state;
}
