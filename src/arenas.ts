/**
 * The five arenas, in ladder order. Each one moves the archers further apart,
 * adds elevation, and introduces cover — the same escalation the original game
 * uses to keep raising the skill floor.
 *
 * `unlockRating` gates the arena on the ladder; `botSkill` (0..1) drives how
 * accurate the single-player opponent is.
 */

import type { ArenaSpec, Obstacle, Vec2 } from './sim';

export interface ArenaDefinition extends ArenaSpec {
  nameKey: string;
  unlockRating: number;
  botSkill: number;
  /** Palette used by the renderer for ground, haze and light tint. */
  palette: {
    ground: number;
    groundAccent: number;
    sky: [number, number];
    fog: number;
    sun: number;
    ambient: number;
  };
  /** Set dressing: model key + placement. Purely cosmetic. */
  props: Array<{
    model: string;
    at: Vec2;
    scale: number;
    rotationY: number;
    z?: number;
  }>;
  /** Terrain platforms the archers stand on, drawn as boxes. */
  platforms: Array<Obstacle & { depth: number }>;
}

const BASE_GRAVITY = 9.81;

export const ARENAS: ArenaDefinition[] = [
  {
    id: 'greenwood',
    nameKey: 'arena.greenwood',
    unlockRating: 0,
    botSkill: 0.32,
    gravity: BASE_GRAVITY,
    wind: 0,
    drag: 0.045,
    spawn: [
      { x: -9, y: 0 },
      { x: 9, y: 0 },
    ],
    obstacles: [],
    platforms: [],
    palette: {
      ground: 0x5c8a3c,
      groundAccent: 0x47702f,
      sky: [0x9fd3f2, 0xdff0fb],
      fog: 0xcfe6f5,
      sun: 0xfff2d6,
      ambient: 0x93b7d4,
    },
    props: [
      { model: 'tree', at: { x: -15, y: 0 }, scale: 1.1, rotationY: 0.4, z: -4 },
      { model: 'tree', at: { x: 14.5, y: 0 }, scale: 0.95, rotationY: 2.1, z: -5 },
      { model: 'tree', at: { x: -3, y: 0 }, scale: 1.25, rotationY: 1.2, z: -9 },
      { model: 'tree', at: { x: 6, y: 0 }, scale: 1.05, rotationY: 3.0, z: -11 },
      { model: 'rock', at: { x: -5.5, y: 0 }, scale: 0.8, rotationY: 0.9, z: -1.6 },
      { model: 'rock', at: { x: 4.8, y: 0 }, scale: 0.6, rotationY: 2.4, z: -1.4 },
      { model: 'crate', at: { x: 11.4, y: 0 }, scale: 0.7, rotationY: 0.2, z: -1.2 },
    ],
  },
  {
    id: 'ruins',
    nameKey: 'arena.ruins',
    unlockRating: 1050,
    botSkill: 0.46,
    gravity: BASE_GRAVITY,
    wind: -0.6,
    drag: 0.05,
    spawn: [
      { x: -12.5, y: 0 },
      { x: 12.5, y: 2.4 },
    ],
    obstacles: [{ x: -0.7, y: 0, w: 1.4, h: 2.6 }],
    platforms: [
      { x: 10.2, y: 0, w: 5.2, h: 2.4, depth: 5 },
      { x: -0.7, y: 0, w: 1.4, h: 2.6, depth: 2.2 },
    ],
    palette: {
      ground: 0x8a8367,
      groundAccent: 0x6f6952,
      sky: [0xc7b89a, 0xf0e7d4],
      fog: 0xded2b8,
      sun: 0xffe7bd,
      ambient: 0xb2a58a,
    },
    props: [
      { model: 'ruin_column', at: { x: -6.2, y: 0 }, scale: 1.0, rotationY: 0.1, z: -3 },
      { model: 'ruin_column', at: { x: 5.4, y: 0 }, scale: 0.85, rotationY: 1.4, z: -3.4 },
      { model: 'ruin_column', at: { x: -14, y: 0 }, scale: 1.15, rotationY: 2.6, z: -6 },
      { model: 'rock', at: { x: 2.2, y: 0 }, scale: 0.9, rotationY: 0.7, z: -1.5 },
      { model: 'rock', at: { x: -9.4, y: 0 }, scale: 0.65, rotationY: 2.9, z: -1.3 },
      { model: 'banner', at: { x: 13.6, y: 2.4 }, scale: 0.9, rotationY: 0, z: -2.2 },
    ],
  },
  {
    id: 'rampart',
    nameKey: 'arena.rampart',
    unlockRating: 1150,
    botSkill: 0.58,
    gravity: BASE_GRAVITY,
    wind: 1.1,
    drag: 0.05,
    spawn: [
      { x: -14, y: 3.2 },
      { x: 14, y: 3.2 },
    ],
    obstacles: [
      { x: -2.4, y: 0, w: 1.6, h: 4.6 },
      { x: 0.8, y: 0, w: 1.6, h: 4.6 },
    ],
    platforms: [
      { x: -17, y: 0, w: 6.4, h: 3.2, depth: 5.4 },
      { x: 10.6, y: 0, w: 6.4, h: 3.2, depth: 5.4 },
      { x: -2.4, y: 0, w: 1.6, h: 4.6, depth: 2.6 },
      { x: 0.8, y: 0, w: 1.6, h: 4.6, depth: 2.6 },
    ],
    palette: {
      ground: 0x6d6f74,
      groundAccent: 0x55575c,
      sky: [0x7fa0c4, 0xd2e2f0],
      fog: 0xbccbdb,
      sun: 0xffeed2,
      ambient: 0x8fa3bb,
    },
    props: [
      { model: 'castle_wall', at: { x: -20.5, y: 0 }, scale: 1.0, rotationY: 0, z: -5 },
      { model: 'castle_wall', at: { x: 17.5, y: 0 }, scale: 1.0, rotationY: 0, z: -5 },
      { model: 'banner', at: { x: -15.2, y: 3.2 }, scale: 0.9, rotationY: 0, z: -2.4 },
      { model: 'banner', at: { x: 15.2, y: 3.2 }, scale: 0.9, rotationY: 0, z: -2.4 },
      { model: 'crate', at: { x: -12.2, y: 3.2 }, scale: 0.65, rotationY: 0.5, z: -1.8 },
      { model: 'crate', at: { x: 12.4, y: 3.2 }, scale: 0.7, rotationY: 2.2, z: -1.6 },
    ],
  },
  {
    id: 'cliffs',
    nameKey: 'arena.cliffs',
    unlockRating: 1280,
    botSkill: 0.71,
    gravity: BASE_GRAVITY,
    wind: -1.9,
    drag: 0.058,
    spawn: [
      { x: -16, y: 5.6 },
      { x: 15, y: 1.2 },
    ],
    obstacles: [{ x: -1.2, y: 0, w: 2.4, h: 6.4 }],
    platforms: [
      { x: -19.5, y: 0, w: 7, h: 5.6, depth: 6 },
      { x: 11.8, y: 0, w: 6.4, h: 1.2, depth: 5.4 },
      { x: -1.2, y: 0, w: 2.4, h: 6.4, depth: 3 },
    ],
    palette: {
      ground: 0x7d6a58,
      groundAccent: 0x5f5044,
      sky: [0xe89a63, 0xf6d9a8],
      fog: 0xe4b98c,
      sun: 0xffcf94,
      ambient: 0xa8815f,
    },
    props: [
      { model: 'rock', at: { x: -22, y: 0 }, scale: 1.5, rotationY: 0.3, z: -6 },
      { model: 'rock', at: { x: 19, y: 0 }, scale: 1.3, rotationY: 1.9, z: -6.5 },
      { model: 'tree', at: { x: -13.5, y: 5.6 }, scale: 0.8, rotationY: 2.4, z: -3.2 },
      { model: 'ruin_column', at: { x: 8.6, y: 1.2 }, scale: 0.7, rotationY: 0.6, z: -2.8 },
      { model: 'rock', at: { x: 4.2, y: 0 }, scale: 1.0, rotationY: 2.7, z: -2 },
    ],
  },
  {
    id: 'citadel',
    nameKey: 'arena.citadel',
    unlockRating: 1420,
    botSkill: 0.85,
    gravity: BASE_GRAVITY,
    wind: 2.4,
    drag: 0.062,
    spawn: [
      { x: -17.5, y: 7.4 },
      { x: 17.5, y: 3.6 },
    ],
    obstacles: [
      { x: -4.2, y: 0, w: 2, h: 8 },
      { x: 2.2, y: 0, w: 2, h: 5.2 },
    ],
    platforms: [
      { x: -21, y: 0, w: 7, h: 7.4, depth: 6.2 },
      { x: 14, y: 0, w: 7, h: 3.6, depth: 6.2 },
      { x: -4.2, y: 0, w: 2, h: 8, depth: 3.2 },
      { x: 2.2, y: 0, w: 2, h: 5.2, depth: 3.2 },
    ],
    palette: {
      ground: 0x4a4e58,
      groundAccent: 0x383b43,
      sky: [0x3d4b6b, 0x8fa2c4],
      fog: 0x6f7f9c,
      sun: 0xd7e3ff,
      ambient: 0x5d6c88,
    },
    props: [
      { model: 'castle_tower', at: { x: -24.5, y: 0 }, scale: 1.0, rotationY: 0, z: -6.5 },
      { model: 'castle_tower', at: { x: 21.5, y: 0 }, scale: 0.92, rotationY: 0, z: -7 },
      { model: 'castle_wall', at: { x: -9, y: 0 }, scale: 1.0, rotationY: 0, z: -9 },
      { model: 'castle_wall', at: { x: 6, y: 0 }, scale: 1.0, rotationY: 0, z: -9 },
      { model: 'banner', at: { x: -18.8, y: 7.4 }, scale: 0.95, rotationY: 0, z: -2.6 },
      { model: 'banner', at: { x: 18.8, y: 3.6 }, scale: 0.95, rotationY: 0, z: -2.6 },
      { model: 'crate', at: { x: -14.4, y: 7.4 }, scale: 0.7, rotationY: 1.1, z: -1.9 },
    ],
  },
];

export function arenaByIndex(index: number): ArenaDefinition {
  const clamped = Math.min(ARENAS.length - 1, Math.max(0, Math.floor(index)));
  return ARENAS[clamped];
}

export function arenaById(id: string): ArenaDefinition {
  return ARENAS.find((a) => a.id === id) ?? ARENAS[0];
}

/** Highest arena the player has earned with their current rating. */
export function highestUnlockedArena(rating: number): number {
  let best = 0;
  ARENAS.forEach((arena, index) => {
    if (rating >= arena.unlockRating) best = index;
  });
  return best;
}
