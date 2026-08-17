/**
 * Cash, the three upgrade tracks, rating and arena unlocks — the meta layer the
 * original game wraps around its duels.
 *
 * The profile is stored in `Usion.cloud` so it follows the player across
 * devices, with a localStorage mirror that keeps the game playable while the
 * network is down or when the page is opened outside the Usion host.
 */

import { ARENAS, highestUnlockedArena } from './arenas';
import type { ArcherStats } from './sim';

export type UpgradeTrack = 'health' | 'damage' | 'headshot';

export interface Profile {
  rating: number;
  cash: number;
  upgrades: Record<UpgradeTrack, number>;
  wins: number;
  losses: number;
  bestArena: number;
}

const CLOUD_KEY = 'profile.v1';
const LOCAL_KEY = 'archers-arena.profile.v1';

export const MAX_UPGRADE_LEVEL = 9;
export const STARTING_RATING = 1000;

const BASE: Record<UpgradeTrack, number> = { health: 100, damage: 18, headshot: 45 };
const PER_LEVEL: Record<UpgradeTrack, number> = { health: 12, damage: 3, headshot: 7 };

export function defaultProfile(): Profile {
  return {
    rating: STARTING_RATING,
    cash: 0,
    upgrades: { health: 0, damage: 0, headshot: 0 },
    wins: 0,
    losses: 0,
    bestArena: 0,
  };
}

/** Rising cost curve, so the last levels are a real goal rather than a formality. */
export function upgradeCost(level: number): number {
  return Math.round(120 * Math.pow(1.55, level));
}

export function statsFor(upgrades: Record<UpgradeTrack, number>): ArcherStats {
  return {
    maxHealth: BASE.health + PER_LEVEL.health * upgrades.health,
    baseDamage: BASE.damage + PER_LEVEL.damage * upgrades.damage,
    headshotDamage: BASE.headshot + PER_LEVEL.headshot * upgrades.headshot,
  };
}

export function trackValue(track: UpgradeTrack, level: number): number {
  return BASE[track] + PER_LEVEL[track] * level;
}

export function canAfford(profile: Profile, track: UpgradeTrack): boolean {
  const level = profile.upgrades[track];
  return level < MAX_UPGRADE_LEVEL && profile.cash >= upgradeCost(level);
}

export function buyUpgrade(profile: Profile, track: UpgradeTrack): Profile {
  if (!canAfford(profile, track)) return profile;
  const level = profile.upgrades[track];
  return {
    ...profile,
    cash: profile.cash - upgradeCost(level),
    upgrades: { ...profile.upgrades, [track]: level + 1 },
  };
}

/** Reward curve: deeper arenas pay more, and a loss still pays something. */
export function settleMatch(profile: Profile, won: boolean, arenaIndex: number): Profile {
  const ratingDelta = won ? 25 + arenaIndex * 3 : -(18 + arenaIndex * 2);
  const cashDelta = won ? 150 + arenaIndex * 60 : 40 + arenaIndex * 12;
  const rating = Math.max(600, profile.rating + ratingDelta);
  return {
    ...profile,
    rating,
    cash: profile.cash + cashDelta,
    wins: profile.wins + (won ? 1 : 0),
    losses: profile.losses + (won ? 0 : 1),
    bestArena: Math.max(profile.bestArena, highestUnlockedArena(rating)),
  };
}

export function rankTitleKey(rating: number): string {
  if (rating >= ARENAS[4].unlockRating) return 'rank.legend';
  if (rating >= ARENAS[3].unlockRating) return 'rank.master';
  if (rating >= ARENAS[2].unlockRating) return 'rank.veteran';
  if (rating >= ARENAS[1].unlockRating) return 'rank.archer';
  return 'rank.novice';
}

function sanitise(raw: unknown): Profile {
  const base = defaultProfile();
  if (!raw || typeof raw !== 'object') return base;
  const value = raw as Partial<Profile>;
  const upgrades = (value.upgrades ?? {}) as Partial<Record<UpgradeTrack, number>>;
  const clampLevel = (n: unknown): number =>
    Math.min(MAX_UPGRADE_LEVEL, Math.max(0, Math.floor(Number(n) || 0)));
  return {
    rating: Math.max(600, Math.floor(Number(value.rating) || STARTING_RATING)),
    cash: Math.max(0, Math.floor(Number(value.cash) || 0)),
    upgrades: {
      health: clampLevel(upgrades.health),
      damage: clampLevel(upgrades.damage),
      headshot: clampLevel(upgrades.headshot),
    },
    wins: Math.max(0, Math.floor(Number(value.wins) || 0)),
    losses: Math.max(0, Math.floor(Number(value.losses) || 0)),
    bestArena: Math.min(
      ARENAS.length - 1,
      Math.max(0, Math.floor(Number(value.bestArena) || 0)),
    ),
  };
}

function readLocal(): Profile | null {
  try {
    const raw = window.localStorage.getItem(LOCAL_KEY);
    return raw ? sanitise(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function writeLocal(profile: Profile): void {
  try {
    window.localStorage.setItem(LOCAL_KEY, JSON.stringify(profile));
  } catch {
    // Private-mode or quota — the cloud copy is still authoritative.
  }
}

/**
 * Cloud first, local mirror as the fallback. Whichever has the higher rating
 * wins, so a match settled offline is not silently thrown away.
 */
export async function loadProfile(): Promise<Profile> {
  const local = readLocal();
  const cloud = window.Usion?.cloud;
  if (!cloud) return local ?? defaultProfile();

  try {
    const remote = await cloud.get(CLOUD_KEY);
    if (!remote) return local ?? defaultProfile();
    const parsed = sanitise(remote);
    if (local && local.rating > parsed.rating) return local;
    writeLocal(parsed);
    return parsed;
  } catch {
    return local ?? defaultProfile();
  }
}

export async function saveProfile(profile: Profile): Promise<void> {
  writeLocal(profile);
  try {
    await window.Usion?.cloud.set(CLOUD_KEY, profile);
  } catch {
    // Keep playing on the local mirror; the next save retries.
  }
}
