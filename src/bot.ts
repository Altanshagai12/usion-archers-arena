/**
 * Single-player opponent.
 *
 * The bot solves the same ballistics the player does — it searches pitch, yaw
 * and power through `simulateShot` and keeps the best — then deliberately
 * degrades the answer by an amount set by the arena's `botSkill`. It also walks
 * its shots in the way a human does: a miss biases the next shot back toward
 * the target, so early arenas feel like a beginner finding the range rather
 * than a machine that is either perfect or random.
 *
 * This only ever runs locally, in single-player, so unseeded randomness is fine
 * here. `sim.ts` stays pure.
 */

import { MAX_PITCH, MAX_YAW, MIN_PITCH, clampPitch, clampYaw, simulateShot } from './sim';
import type { ArcherState, ArenaSpec, ShotInput, Vec3 } from './sim';

const COARSE_PITCH = 16;
const COARSE_POWER = 8;
const COARSE_YAW = 5;
const REFINE_STEPS = 5;

const POWER_MIN = 0.4;
const POWER_MAX = 1;

/** Aim point: the middle of the torso, where a player instinctively aims. */
function chestOf(archer: ArcherState): Vec3 {
  return { x: archer.pos.x, y: archer.pos.y + 1.15, z: archer.pos.z };
}

function closestApproach(path: Vec3[], target: Vec3): number {
  let best = Infinity;
  for (const p of path) {
    const dx = p.x - target.x;
    const dy = p.y - target.y;
    const dz = p.z - target.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** Higher is better. A clean hit always beats any miss. */
function scoreShot(
  arena: ArenaSpec,
  archers: [ArcherState, ArcherState],
  shooter: 0 | 1,
  input: ShotInput,
): number {
  const result = simulateShot(arena, archers, shooter, input);
  if (result.hit) {
    if (result.hit.zone === 'head') return 1000;
    if (result.hit.zone === 'body') return 900;
    return 800;
  }
  const target = chestOf(archers[shooter === 0 ? 1 : 0]);
  return -closestApproach(result.path, target) - (result.blocked ? 8 : 0);
}

/** Box–Muller, clamped so a freak sample cannot send an arrow into orbit. */
function gaussian(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(-2.5, Math.min(2.5, n));
}

export interface BotMemory {
  /** Signed range error of the previous shot, metres (+ = long). */
  lastError: number | null;
  shotsTaken: number;
}

export function createBotMemory(): BotMemory {
  return { lastError: null, shotsTaken: 0 };
}

function solveBestShot(
  arena: ArenaSpec,
  archers: [ArcherState, ArcherState],
  shooter: 0 | 1,
): ShotInput {
  let best: ShotInput = { pitch: 0.25, yaw: 0, power: 0.8 };
  let bestScore = -Infinity;

  for (let i = 0; i < COARSE_PITCH; i += 1) {
    const pitch = MIN_PITCH + ((MAX_PITCH - MIN_PITCH) * i) / (COARSE_PITCH - 1);
    for (let j = 0; j < COARSE_POWER; j += 1) {
      const power = POWER_MIN + ((POWER_MAX - POWER_MIN) * j) / (COARSE_POWER - 1);
      for (let k = 0; k < COARSE_YAW; k += 1) {
        const yaw = -MAX_YAW + (2 * MAX_YAW * k) / (COARSE_YAW - 1);
        const candidate = { pitch, yaw, power };
        const score = scoreShot(arena, archers, shooter, candidate);
        if (score > bestScore) {
          bestScore = score;
          best = candidate;
        }
      }
    }
  }

  let pitchSpan = (MAX_PITCH - MIN_PITCH) / (COARSE_PITCH - 1);
  let powerSpan = (POWER_MAX - POWER_MIN) / (COARSE_POWER - 1);
  let yawSpan = (2 * MAX_YAW) / (COARSE_YAW - 1);

  for (let pass = 0; pass < 2; pass += 1) {
    for (let i = 0; i < REFINE_STEPS; i += 1) {
      const pitch = best.pitch - pitchSpan + (2 * pitchSpan * i) / (REFINE_STEPS - 1);
      for (let j = 0; j < REFINE_STEPS; j += 1) {
        const power = Math.min(
          POWER_MAX,
          Math.max(POWER_MIN, best.power - powerSpan + (2 * powerSpan * j) / (REFINE_STEPS - 1)),
        );
        for (let k = 0; k < REFINE_STEPS; k += 1) {
          const yaw = best.yaw - yawSpan + (2 * yawSpan * k) / (REFINE_STEPS - 1);
          const candidate = { pitch: clampPitch(pitch), yaw: clampYaw(yaw), power };
          const score = scoreShot(arena, archers, shooter, candidate);
          if (score > bestScore) {
            bestScore = score;
            best = candidate;
          }
        }
      }
    }
    pitchSpan /= 3;
    powerSpan /= 3;
    yawSpan /= 3;
  }

  return best;
}

/**
 * Pick the bot's next shot.
 *
 * `skill` is 0..1 from the arena definition. At 0.34 the bot sprays and needs
 * several shots to find the range; at 0.84 it is close to lethal but still
 * misses often enough to lose.
 */
export function chooseBotShot(
  arena: ArenaSpec,
  archers: [ArcherState, ArcherState],
  shooter: 0 | 1,
  skill: number,
  memory: BotMemory,
): ShotInput {
  const ideal = solveBestShot(arena, archers, shooter);
  const sloppiness = 1 - Math.min(1, Math.max(0, skill));

  // A bot that has already fired a few times has "walked in" its range.
  const warmup = memory.shotsTaken === 0 ? 1.4 : memory.shotsTaken === 1 ? 1.12 : 1;
  const pitchError = gaussian() * 0.055 * sloppiness * warmup;
  const yawError = gaussian() * 0.03 * sloppiness * warmup;
  const powerError = gaussian() * 0.09 * sloppiness * warmup;

  // Correct part of the previous miss — the human "one notch higher" instinct.
  const correction = memory.lastError === null ? 0 : -memory.lastError * 0.0012 * skill;

  memory.shotsTaken += 1;

  return {
    pitch: clampPitch(ideal.pitch + pitchError + correction),
    yaw: clampYaw(ideal.yaw + yawError),
    power: Math.min(1, Math.max(0.2, ideal.power + powerError)),
  };
}

/**
 * Feed the outcome of the bot's shot back into its memory so the next one can
 * correct. Positive means the arrow flew past the target.
 */
export function recordBotOutcome(
  memory: BotMemory,
  path: Vec3[],
  target: ArcherState,
  shooterFacing: 1 | -1,
): void {
  const last = path[path.length - 1];
  if (!last) return;
  memory.lastError = (last.z - target.pos.z) * shooterFacing;
}
