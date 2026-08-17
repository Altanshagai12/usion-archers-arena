/**
 * Single-player opponent.
 *
 * The bot solves the same ballistics the player does — it searches (angle,
 * power) pairs through `simulateShot` and keeps the best — then deliberately
 * degrades the answer by an amount set by the arena's `botSkill`. It also walks
 * its shots in the way a human does: a miss biases the next shot back toward
 * the target, so early arenas feel like a beginner finding the range rather
 * than a machine that is either perfect or random.
 *
 * This only ever runs locally, in single-player, so unseeded randomness is fine
 * here. `sim.ts` stays pure.
 */

import { simulateShot } from './sim';
import type { ArcherState, ArenaSpec, ShotInput, Vec2 } from './sim';

const COARSE_ANGLES = 14;
const COARSE_POWERS = 7;
const REFINE_STEPS = 5;

const ANGLE_MIN = -0.15;
const ANGLE_MAX = 1.32;
const POWER_MIN = 0.34;
const POWER_MAX = 1;

/** Aim point: the middle of the torso, the same place a player instinctively aims. */
function chestOf(archer: ArcherState): Vec2 {
  return { x: archer.pos.x, y: archer.pos.y + 1.15 };
}

function closestApproach(path: Vec2[], target: Vec2): number {
  let best = Infinity;
  for (const p of path) {
    const dx = p.x - target.x;
    const dy = p.y - target.y;
    const d = dx * dx + dy * dy;
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
  const distance = closestApproach(result.path, target);
  // Blocked shots are worse than an open miss of the same distance.
  return -distance - (result.blocked ? 6 : 0);
}

/** Box–Muller, clamped so a freak sample can't send an arrow into orbit. */
function gaussian(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(-2.5, Math.min(2.5, n));
}

export interface BotMemory {
  /** Signed miss distance of the previous shot, in metres (+ = overshot). */
  lastError: number | null;
  shotsTaken: number;
}

export function createBotMemory(): BotMemory {
  return { lastError: null, shotsTaken: 0 };
}

/** Grid search, then a local refine around the winner. */
function solveBestShot(
  arena: ArenaSpec,
  archers: [ArcherState, ArcherState],
  shooter: 0 | 1,
): ShotInput {
  let best: ShotInput = { angle: 0.6, power: 0.8 };
  let bestScore = -Infinity;

  for (let i = 0; i < COARSE_ANGLES; i += 1) {
    const angle = ANGLE_MIN + ((ANGLE_MAX - ANGLE_MIN) * i) / (COARSE_ANGLES - 1);
    for (let j = 0; j < COARSE_POWERS; j += 1) {
      const power = POWER_MIN + ((POWER_MAX - POWER_MIN) * j) / (COARSE_POWERS - 1);
      const candidate = { angle, power };
      const score = scoreShot(arena, archers, shooter, candidate);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
  }

  let angleSpan = (ANGLE_MAX - ANGLE_MIN) / (COARSE_ANGLES - 1);
  let powerSpan = (POWER_MAX - POWER_MIN) / (COARSE_POWERS - 1);
  for (let pass = 0; pass < 2; pass += 1) {
    for (let i = 0; i < REFINE_STEPS; i += 1) {
      const angle = best.angle - angleSpan + (2 * angleSpan * i) / (REFINE_STEPS - 1);
      for (let j = 0; j < REFINE_STEPS; j += 1) {
        const power = Math.min(
          POWER_MAX,
          Math.max(POWER_MIN, best.power - powerSpan + (2 * powerSpan * j) / (REFINE_STEPS - 1)),
        );
        const candidate = { angle, power };
        const score = scoreShot(arena, archers, shooter, candidate);
        if (score > bestScore) {
          bestScore = score;
          best = candidate;
        }
      }
    }
    angleSpan /= 3;
    powerSpan /= 3;
  }

  return best;
}

/**
 * Pick the bot's next shot.
 *
 * `skill` is 0..1 from the arena definition. At 0.3 the bot sprays wildly and
 * needs several shots to find the range; at 0.85 it is close to lethal but
 * still misses often enough to lose.
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
  const warmup = memory.shotsTaken === 0 ? 1.35 : memory.shotsTaken === 1 ? 1.1 : 1;
  const angleError = gaussian() * 0.155 * sloppiness * warmup;
  const powerError = gaussian() * 0.13 * sloppiness * warmup;

  // Correct part of the previous miss — the human "one notch higher" instinct.
  const correction = memory.lastError === null ? 0 : -memory.lastError * 0.012 * skill;

  memory.shotsTaken += 1;

  return {
    angle: ideal.angle + angleError + correction,
    power: Math.min(1, Math.max(0.2, ideal.power + powerError)),
  };
}

/**
 * Feed the outcome of the bot's shot back into its memory so the next one can
 * correct. Positive means the arrow passed beyond the target.
 */
export function recordBotOutcome(
  memory: BotMemory,
  path: Vec2[],
  target: ArcherState,
  shooterFacing: 1 | -1,
): void {
  const last = path[path.length - 1];
  if (!last) return;
  memory.lastError = (last.x - target.pos.x) * shooterFacing;
}
