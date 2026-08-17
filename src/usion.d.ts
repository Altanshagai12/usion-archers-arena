/**
 * Minimal typings for the Usion SDK, which is loaded from
 * https://usions.com/usion-sdk.js at runtime (Path B — we load it ourselves).
 *
 * Only the surface this game actually uses is declared. Everything here must
 * exist in the real SDK; never invent methods (`Usion.ready`, `Usion.user.info`
 * and `Usion.game.emit` do NOT exist).
 */

export interface UsionConfig {
  userId: string;
  userName: string;
  userAvatar?: string;
  balance?: number;
  theme: 'light' | 'dark';
  language: string;
  roomId?: string | null;
  playerIds?: string[];
  serviceId?: string;
  socketUrl?: string;
}

export interface LaunchParams {
  path?: string | null;
  ref?: string | null;
  roomId?: string | null;
  mode?: 'single' | 'multiplayer';
}

export interface GameMessage {
  player_id: string;
  action_type: string;
  action_data: any;
  sequence?: number;
}

export interface LeaderboardEntry {
  user_id: string;
  name?: string;
  avatar?: string;
  score: number;
  rank: number;
  is_me: boolean;
}

export interface UsionGame {
  connect(): Promise<any>;
  join(roomId: string): Promise<any>;
  leave(): Promise<any>;
  disconnect(): void;
  action(type: string, data?: any, opts?: { queueOffline?: boolean }): Promise<any>;
  realtime(type: string, data?: any): void;
  requestSync(lastSequence?: number): void;
  requestRematch(): void;
  forfeit(): Promise<any>;
  invite(opts?: { maxPlayers?: number }): Promise<any>;
  isMultiplayer(): boolean;
  reportResult(result: {
    winnerId?: string;
    draw?: boolean;
    scores?: Record<string, number>;
    displayScore?: string;
    metric?: string;
    matchId?: string;
  }): Promise<any> | void;
  onJoined(cb: (data: any) => void): void;
  onPlayerJoined(cb: (data: any) => void): void;
  onPlayerLeft(cb: (data: any) => void): void;
  onAction(cb: (message: GameMessage) => void): void;
  onRealtime(cb: (message: GameMessage) => void): void;
  onSync(cb: (data: any) => void): void;
  onRoomAssigned(cb: (data: { roomId: string }) => void): void;
  onGameFinished(cb: (data: any) => void): void;
  onGameRestarted(cb: (data: any) => void): void;
  onDisconnect(cb: (reason: any) => void): void;
  onReconnect(cb: (attempt: any) => void): void;
  onError(cb: (err: any) => void): void;
  onConnectionState?(cb: (state: string) => void): void;
  simulateNetwork?(opts: { latencyMs?: number; jitterMs?: number; lossPct?: number }): void;
}

export interface UsionSdk {
  init(cb: (config: UsionConfig) => void): void;
  version: string;
  getLaunchParams(): LaunchParams;
  getTheme(): 'light' | 'dark';
  getLanguage(): string;
  exit(): void;
  claimBackButton(cb: () => boolean | void): void;
  user: {
    getId(): string;
    getName(): string;
    getAvatar(): string | undefined;
  };
  game: UsionGame;
  cloud: {
    get(key: string): Promise<any>;
    set(key: string, value: any): Promise<any>;
    remove(key: string): Promise<any>;
    keys(): Promise<string[]>;
  };
  storage: {
    get(key: string): Promise<any>;
    set(key: string, value: any): Promise<any>;
  };
  leaderboard: {
    submit(score: number, metadata?: any): Promise<any>;
    top(opts?: { limit?: number }): Promise<LeaderboardEntry[]>;
    friends(opts?: { limit?: number }): Promise<LeaderboardEntry[]>;
    me(): Promise<{ score: number; rank: number; total: number }>;
  };
}

declare global {
  interface Window {
    Usion?: UsionSdk;
  }
}

export {};
