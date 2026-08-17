/**
 * The five arenas, in ladder order.
 *
 * Each one is a shooting range: you stand at z = 0 and the opponent stands at
 * z = range. Later arenas push the range out, split the two firing heights and
 * add crosswind, so the elevation you dial on the gauge matters more and more.
 *
 * Props are placed in world space (x lateral, y height, z down-range) and are
 * purely decorative unless they also appear in `obstacles`.
 */

import type { ArenaSpec, Obstacle, Vec3 } from './sim';

export interface ArenaProp {
  model: string;
  at: Vec3;
  scale: number;
  rotationY: number;
}

export interface ArenaDefinition extends ArenaSpec {
  nameKey: string;
  unlockRating: number;
  botSkill: number;
  palette: {
    ground: number;
    groundAccent: number;
    ridge: number;
    sky: [number, number];
    fog: number;
    sun: number;
    ambient: number;
  };
  props: ArenaProp[];
  /** Raised mounds the archers stand on, drawn as low cylinders. */
  mounds: Array<{ at: Vec3; radius: number; height: number }>;
  /** Distant ridge line: [xOffset, height, radius] per peak. */
  ridges: Array<[number, number, number]>;
}

const BASE_GRAVITY = 9.81;

/** Fence posts + rails running down both sides of a range. */
function railing(z0: number, z1: number, x: number, step = 4.5): ArenaProp[] {
  const out: ArenaProp[] = [];
  for (let z = z0; z <= z1; z += step) {
    out.push({ model: 'fence', at: { x, y: 0, z }, scale: 1, rotationY: 0 });
  }
  return out;
}

/** Hay bales stacked as cover, and the obstacle boxes that match them. */
function bales(spots: Array<[number, number]>, y = 0): ArenaProp[] {
  return spots.map(([x, z]) => ({
    model: 'crate',
    at: { x, y, z },
    scale: 1.15,
    rotationY: (x * 0.7 + z * 0.3) % 1.4,
  }));
}

function baleObstacles(spots: Array<[number, number]>, y = 0): Obstacle[] {
  return spots.map(([x, z]) => ({
    x: x - 0.55,
    y,
    z: z - 0.55,
    w: 1.1,
    h: 1.05,
    d: 1.1,
  }));
}

const RUINS_BALES: Array<[number, number]> = [
  [-2.6, 22],
  [2.9, 26],
];
const RAMPART_BALES: Array<[number, number]> = [
  [-3.2, 20],
  [0.2, 30],
  [3.4, 24],
];
const CLIFF_BALES: Array<[number, number]> = [
  [-2.2, 26],
  [2.4, 38],
];
const CITADEL_BALES: Array<[number, number]> = [
  [-3.4, 24],
  [-0.4, 40],
  [3.1, 32],
  [1.4, 55],
];

export const ARENAS: ArenaDefinition[] = [
  {
    id: 'greenwood',
    nameKey: 'arena.greenwood',
    unlockRating: 0,
    botSkill: 0.34,
    gravity: BASE_GRAVITY,
    wind: 0,
    drag: 0.05,
    range: 30,
    elevation: [1.1, 0],
    obstacles: [],
    mounds: [{ at: { x: 0, y: 0, z: 0 }, radius: 3.6, height: 1.1 }],
    ridges: [
      [-34, 26, 20],
      [-8, 34, 24],
      [22, 29, 22],
      [48, 22, 18],
    ],
    palette: {
      ground: 0x6f8f4a,
      groundAccent: 0x5b7a3c,
      ridge: 0x6c7079,
      sky: [0x7fb6e8, 0xdcecf8],
      fog: 0xc9e0f2,
      sun: 0xfff4dd,
      ambient: 0x86a86a,
    },
    props: [
      ...railing(6, 34, -7.5),
      ...railing(6, 34, 7.5),
      { model: 'tree', at: { x: -11, y: 0, z: 14 }, scale: 1.1, rotationY: 0.4 },
      { model: 'tree', at: { x: 12, y: 0, z: 20 }, scale: 0.95, rotationY: 2.1 },
      { model: 'tree', at: { x: -13.5, y: 0, z: 30 }, scale: 1.25, rotationY: 1.2 },
      { model: 'tree', at: { x: 14, y: 0, z: 38 }, scale: 1.05, rotationY: 3 },
      { model: 'tree', at: { x: -9, y: 0, z: 44 }, scale: 1.15, rotationY: 0.8 },
      { model: 'target', at: { x: -5.5, y: 0, z: 19 }, scale: 1, rotationY: 0 },
      { model: 'target', at: { x: 5.8, y: 0, z: 24 }, scale: 1, rotationY: 0 },
      { model: 'rock', at: { x: -6.4, y: 0, z: 34 }, scale: 0.8, rotationY: 0.9 },
      ...bales([
        [-4.2, 12],
        [4.4, 15],
      ]),
    ],
  },
  {
    id: 'ruins',
    nameKey: 'arena.ruins',
    unlockRating: 1050,
    botSkill: 0.47,
    gravity: BASE_GRAVITY,
    wind: -1.1,
    drag: 0.052,
    range: 40,
    elevation: [1.1, 1.9],
    obstacles: baleObstacles(RUINS_BALES),
    mounds: [
      { at: { x: 0, y: 0, z: 0 }, radius: 3.6, height: 1.1 },
      { at: { x: 0, y: 0, z: 40 }, radius: 3.2, height: 1.9 },
    ],
    ridges: [
      [-30, 30, 22],
      [4, 38, 26],
      [36, 27, 20],
    ],
    palette: {
      ground: 0x8d8562,
      groundAccent: 0x736c4f,
      ridge: 0x8a8070,
      sky: [0xbfae8c, 0xf0e6d2],
      fog: 0xdccfb2,
      sun: 0xffe9c4,
      ambient: 0xa2946f,
    },
    props: [
      ...railing(6, 44, -8),
      ...railing(6, 44, 8),
      { model: 'ruin_column', at: { x: -6.2, y: 0, z: 16 }, scale: 1, rotationY: 0.1 },
      { model: 'ruin_column', at: { x: 5.4, y: 0, z: 30 }, scale: 0.85, rotationY: 1.4 },
      { model: 'ruin_column', at: { x: -7.4, y: 0, z: 36 }, scale: 1.15, rotationY: 2.6 },
      { model: 'rock', at: { x: 6.2, y: 0, z: 21 }, scale: 0.9, rotationY: 0.7 },
      { model: 'target', at: { x: -4.8, y: 0, z: 27 }, scale: 1, rotationY: 0 },
      { model: 'banner', at: { x: 3.2, y: 1.9, z: 41.5 }, scale: 0.9, rotationY: 0 },
      ...bales(RUINS_BALES),
    ],
  },
  {
    id: 'rampart',
    nameKey: 'arena.rampart',
    unlockRating: 1150,
    botSkill: 0.58,
    gravity: BASE_GRAVITY,
    wind: 1.9,
    drag: 0.052,
    range: 50,
    elevation: [2.4, 2.4],
    obstacles: baleObstacles(RAMPART_BALES),
    mounds: [
      { at: { x: 0, y: 0, z: 0 }, radius: 3.8, height: 2.4 },
      { at: { x: 0, y: 0, z: 50 }, radius: 3.8, height: 2.4 },
    ],
    ridges: [
      [-26, 33, 24],
      [10, 41, 28],
      [44, 30, 22],
    ],
    palette: {
      ground: 0x6e7669,
      groundAccent: 0x585f54,
      ridge: 0x6a6f78,
      sky: [0x6f97c0, 0xd3e3f0],
      fog: 0xb9cbdb,
      sun: 0xffeed6,
      ambient: 0x7c8f9e,
    },
    props: [
      ...railing(6, 54, -8.5),
      ...railing(6, 54, 8.5),
      { model: 'castle_wall', at: { x: -16, y: 0, z: 30 }, scale: 1, rotationY: 0 },
      { model: 'castle_wall', at: { x: 16, y: 0, z: 30 }, scale: 1, rotationY: 0 },
      { model: 'banner', at: { x: -2.6, y: 2.4, z: 51 }, scale: 0.9, rotationY: 0 },
      { model: 'banner', at: { x: 2.6, y: 2.4, z: 51 }, scale: 0.9, rotationY: 0 },
      { model: 'target', at: { x: -5.6, y: 0, z: 34 }, scale: 1, rotationY: 0 },
      { model: 'target', at: { x: 5.6, y: 0, z: 40 }, scale: 1, rotationY: 0 },
      { model: 'tree', at: { x: -12, y: 0, z: 46 }, scale: 1, rotationY: 2.4 },
      ...bales(RAMPART_BALES),
    ],
  },
  {
    id: 'cliffs',
    nameKey: 'arena.cliffs',
    unlockRating: 1280,
    botSkill: 0.7,
    gravity: BASE_GRAVITY,
    wind: -3.1,
    drag: 0.058,
    range: 62,
    elevation: [4.2, 0.6],
    obstacles: baleObstacles(CLIFF_BALES),
    mounds: [
      { at: { x: 0, y: 0, z: 0 }, radius: 4.4, height: 4.2 },
      { at: { x: 0, y: 0, z: 62 }, radius: 3.4, height: 0.6 },
    ],
    ridges: [
      [-30, 36, 24],
      [6, 44, 30],
      [42, 32, 24],
    ],
    palette: {
      ground: 0x8a7358,
      groundAccent: 0x6b5844,
      ridge: 0x7d6752,
      sky: [0xe08a52, 0xf7dcae],
      fog: 0xe4b98c,
      sun: 0xffc98a,
      ambient: 0xa8815f,
    },
    props: [
      ...railing(8, 60, -9),
      ...railing(8, 60, 9),
      { model: 'rock', at: { x: -10, y: 0, z: 20 }, scale: 1.5, rotationY: 0.3 },
      { model: 'rock', at: { x: 11, y: 0, z: 34 }, scale: 1.3, rotationY: 1.9 },
      { model: 'rock', at: { x: -7.5, y: 0, z: 48 }, scale: 1, rotationY: 2.7 },
      { model: 'tree', at: { x: 9, y: 0, z: 12 }, scale: 0.8, rotationY: 2.4 },
      { model: 'target', at: { x: -4.4, y: 0, z: 44 }, scale: 1, rotationY: 0 },
      { model: 'ruin_column', at: { x: 6.6, y: 0, z: 56 }, scale: 0.7, rotationY: 0.6 },
      ...bales(CLIFF_BALES),
    ],
  },
  {
    id: 'citadel',
    nameKey: 'arena.citadel',
    unlockRating: 1420,
    botSkill: 0.84,
    gravity: BASE_GRAVITY,
    wind: 3.8,
    drag: 0.062,
    range: 75,
    elevation: [2.2, 5.4],
    obstacles: baleObstacles(CITADEL_BALES),
    mounds: [
      { at: { x: 0, y: 0, z: 0 }, radius: 4, height: 2.2 },
      { at: { x: 0, y: 0, z: 75 }, radius: 4.2, height: 5.4 },
    ],
    ridges: [
      [-28, 40, 26],
      [8, 48, 32],
      [46, 36, 26],
    ],
    palette: {
      ground: 0x434a52,
      groundAccent: 0x343a41,
      ridge: 0x3d4653,
      sky: [0x2f3d5c, 0x7f93b8],
      fog: 0x5f6f8c,
      sun: 0xcfdcf7,
      ambient: 0x4d5c76,
    },
    props: [
      ...railing(8, 72, -9.5),
      ...railing(8, 72, 9.5),
      { model: 'castle_tower', at: { x: -17, y: 0, z: 66 }, scale: 1, rotationY: 0 },
      { model: 'castle_tower', at: { x: 17, y: 0, z: 66 }, scale: 0.92, rotationY: 0 },
      { model: 'castle_wall', at: { x: -14, y: 0, z: 34 }, scale: 1, rotationY: 0 },
      { model: 'castle_wall', at: { x: 14, y: 0, z: 34 }, scale: 1, rotationY: 0 },
      { model: 'banner', at: { x: -3, y: 5.4, z: 76 }, scale: 0.95, rotationY: 0 },
      { model: 'banner', at: { x: 3, y: 5.4, z: 76 }, scale: 0.95, rotationY: 0 },
      { model: 'target', at: { x: -5.2, y: 0, z: 46 }, scale: 1, rotationY: 0 },
      { model: 'target', at: { x: 5.2, y: 0, z: 58 }, scale: 1, rotationY: 0 },
      ...bales(CITADEL_BALES),
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
