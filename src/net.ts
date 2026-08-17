/**
 * Everything that talks to the Usion SDK.
 *
 * Two rules from the platform's multiplayer contract are enforced here rather
 * than left to the caller:
 *
 *  - Handlers are registered UP FRONT, even when the game launched solo. A solo
 *    launch can be promoted to a live room at any moment when the user taps the
 *    host's Share button (`onRoomAssigned`), and handlers wired after that point
 *    would miss the opening events.
 *  - Moves are applied only when they come back through `onAction`. The SDK
 *    echoes every action with an authoritative sequence and dedupes replays, so
 *    that is the one path where each move is seen exactly once.
 */

import type { GameMessage, LaunchParams, LeaderboardEntry, UsionConfig } from './usion';

export interface NetHandlers {
  onAction(message: GameMessage): void;
  onRealtime(message: GameMessage): void;
  onSync(data: any): void;
  onPlayerJoined(playerIds: string[]): void;
  onPlayerLeft(playerIds: string[]): void;
  onRoomAssigned(roomId: string): void;
  onConnectionChange(online: boolean): void;
}

export class Net {
  private readonly sdk = window.Usion;
  private joinedRoom: string | null = null;
  private playerIds: string[] = [];

  constructor(private readonly handlers: NetHandlers) {}

  get available(): boolean {
    return Boolean(this.sdk);
  }

  /** True when running inside the Usion host; false for local `npm run dev`. */
  get embedded(): boolean {
    return Boolean(this.sdk?.game);
  }

  get roster(): string[] {
    return this.playerIds;
  }

  get roomId(): string | null {
    return this.joinedRoom;
  }

  myId(): string {
    return this.sdk?.user.getId() ?? 'local-player';
  }

  myName(): string {
    return this.sdk?.user.getName() ?? 'You';
  }

  launchParams(): LaunchParams {
    try {
      return this.sdk?.getLaunchParams() ?? {};
    } catch {
      return {};
    }
  }

  /** Wire every handler. Safe to call before any room exists. */
  registerHandlers(config: UsionConfig): void {
    const game = this.sdk?.game;
    if (!game) return;

    this.playerIds = config.playerIds ?? [];

    game.onAction((message) => this.handlers.onAction(message));
    game.onRealtime((message) => this.handlers.onRealtime(message));
    game.onSync((data) => this.handlers.onSync(data));

    game.onJoined((data: any) => {
      if (Array.isArray(data?.player_ids)) this.playerIds = data.player_ids;
      this.handlers.onPlayerJoined(this.playerIds);
    });

    game.onPlayerJoined((data: any) => {
      if (Array.isArray(data?.player_ids)) this.playerIds = data.player_ids;
      this.handlers.onPlayerJoined(this.playerIds);
    });

    game.onPlayerLeft((data: any) => {
      if (Array.isArray(data?.player_ids)) this.playerIds = data.player_ids;
      this.handlers.onPlayerLeft(this.playerIds);
    });

    // Solo → host promotion: the SDK has already set roomId/mode and is
    // joining; we only have to flip the UI over.
    game.onRoomAssigned((data) => {
      this.joinedRoom = data.roomId;
      this.handlers.onRoomAssigned(data.roomId);
    });

    game.onDisconnect(() => this.handlers.onConnectionChange(false));
    game.onReconnect(() => this.handlers.onConnectionChange(true));
    game.onError((error: any) => {
      console.warn('[archers-arena] game error', error);
      // A detached socket is recoverable — ask for the authoritative log back.
      if (error?.code === 'NOT_IN_ROOM') game.requestSync();
    });
  }

  async connectAndJoin(roomId: string): Promise<boolean> {
    const game = this.sdk?.game;
    if (!game) return false;
    try {
      await game.connect();
      const ack: any = await game.join(roomId);
      this.joinedRoom = roomId;
      if (Array.isArray(ack?.player_ids)) this.playerIds = ack.player_ids;
      return true;
    } catch (error) {
      console.warn('[archers-arena] join failed', error);
      return false;
    }
  }

  async sendAction(type: string, data: unknown): Promise<void> {
    const game = this.sdk?.game;
    if (!game || !this.joinedRoom) return;
    try {
      // Turn-based moves are safe to queue across a blip; realtime aim is not.
      await game.action(type, data, { queueOffline: true });
    } catch (error) {
      console.warn(`[archers-arena] action "${type}" failed`, error);
    }
  }

  sendRealtime(type: string, data: unknown): void {
    const game = this.sdk?.game;
    if (!game || !this.joinedRoom) return;
    try {
      game.realtime(type, data);
    } catch {
      // Aim previews are cosmetic — dropping one is fine.
    }
  }

  async invite(): Promise<void> {
    try {
      await this.sdk?.game.invite({ maxPlayers: 2 });
    } catch (error) {
      console.warn('[archers-arena] invite failed', error);
    }
  }

  /** Host-only, exactly once per match — drives the DM/group result cards. */
  reportResult(winnerId: string, scores: Record<string, number>, displayScore: string): void {
    try {
      this.sdk?.game.reportResult({ winnerId, scores, displayScore, metric: 'health' });
    } catch (error) {
      console.warn('[archers-arena] reportResult failed', error);
    }
  }

  async submitRating(rating: number): Promise<void> {
    try {
      await this.sdk?.leaderboard.submit(rating);
    } catch (error) {
      console.warn('[archers-arena] leaderboard submit failed', error);
    }
  }

  async records(mode: 'friends' | 'global'): Promise<LeaderboardEntry[]> {
    try {
      const board = this.sdk?.leaderboard;
      if (!board) return [];
      return mode === 'friends'
        ? await board.friends({ limit: 10 })
        : await board.top({ limit: 10 });
    } catch {
      return [];
    }
  }

  leave(): void {
    const game = this.sdk?.game;
    if (!game || !this.joinedRoom) return;
    try {
      game.leave();
    } catch {
      // Leaving is best-effort; the room prunes stale players anyway.
    }
    this.joinedRoom = null;
  }

  exit(): void {
    try {
      this.sdk?.exit();
    } catch {
      // Standalone: nothing to exit to.
    }
  }
}
