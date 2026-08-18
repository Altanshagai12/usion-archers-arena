/**
 * When a full room may lock its match in.
 *
 * This lives apart from the app object because it is the rule that hung a live
 * match. The first seat is the one that sends `start`, and it used to wait for
 * its OWN `ready` to travel to the relay and come back before it would do so.
 *
 * An embedded mini-app relays actions through the host by postMessage, and
 * that path carries no acknowledgement — the SDK posts the message and
 * resolves immediately, so an action the backend rejects is dropped in
 * silence. One lost echo was therefore enough to leave both players staring at
 * "waiting for opponent" with a room that was visibly full.
 *
 * Our own numbers never needed a round trip. Only the peer's do.
 */

import type { ArcherStats } from './sim';

export interface StartPlan {
  /**
   * Seat order for the match. Seat 0 shoots toward +z from the near mound;
   * seat 1 shoots back from the far one, which stands at a different height.
   *
   * This travels in the `start` action so every client — including one that
   * rejoins later — seats the players from one authoritative record instead of
   * from its own asynchronous view of the room.
   */
  players: [string, string];
  stats: [ArcherStats, ArcherStats];
}

/**
 * The match to start, or null if this client must not start one yet.
 *
 * `announced` holds the stats each player has broadcast, keyed by player id;
 * `mine` is used for our own seat whether or not our announcement came back.
 */
export function startPlan(
  roster: readonly string[],
  myId: string,
  mine: ArcherStats,
  announced: ReadonlyMap<string, ArcherStats>,
): StartPlan | null {
  // Exactly one client locks the match, or two `start` actions race.
  if (roster.length < 2 || roster[0] !== myId) return null;

  const statsOf = (playerId: string): ArcherStats | undefined =>
    playerId === myId ? mine : announced.get(playerId);

  const first = statsOf(roster[0]);
  const second = statsOf(roster[1]);
  if (!first || !second) return null;

  return { players: [roster[0], roster[1]], stats: [first, second] };
}
