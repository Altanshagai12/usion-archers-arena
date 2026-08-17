# Archers Arena

A turn-based 3D archery duel for the [Usion](https://usions.com) platform. Two
archers stand at fixed spots on opposite sides of an arena; you drag to pull the
bow, judge the elevation and the wind, and let go. First to empty the other's
health wins.

Play a friend over Usion's multiplayer rails, or play the bot solo.

- **Renderer:** three.js
- **Meshes:** generated with Higgsfield (Tripo text-to-3D), then re-textured and
  meshopt-compressed for phones
- **Multiplayer:** Usion platform relay, turn-based (`Usion.game.action`)
- **Hosting:** static build on GitHub Pages — no game server

## How the netcode works

A shot crosses the network as `{angle, power}` and nothing else.

`src/sim.ts` is a pure, deterministic ballistics solver. Every client folds the
same ordered action log through the same reducer (`src/match.ts`), so both
players — and a player who rejoins mid-match — resolve the identical trajectory,
the identical hit zone and the identical damage. There is no per-frame state
sync, no server, and no way for the two screens to disagree.

The only realtime traffic is a throttled `aim` message so you can watch your
opponent's bow move while they line up. It is purely cosmetic; dropping it
changes nothing.

The bot (`src/bot.ts`) drives the same solver: it grid-searches (angle, power)
for the best shot, then degrades it by an amount set by the arena's `botSkill`,
and walks its aim in across turns the way a human does.

## Layout

```
src/
  sim.ts          deterministic ballistics + hit zones      (pure)
  match.ts        match state as a reducer over actions      (pure)
  bot.ts          single-player opponent                     (pure + Math.random)
  arenas.ts       the five arenas and their difficulty curve
  progression.ts  cash, upgrade tracks, rating, persistence
  net.ts          all Usion SDK contact
  input.ts        drag-to-aim gesture
  main.ts         boot + match loop
  render/         three.js scene, models, archer rig, arena set dressing
  ui/             HUD, menus, styles
tools/
  compress-models.mjs   assets_raw/*.glb → public/models/*.glb
test/             vitest suites for sim, match reducer and bot
```

## Develop

```bash
npm install
npm run dev        # http://localhost:3017 — runs the bot game without a host
npm test           # 24 unit tests over the pure logic
npm run typecheck
npm run build
```

Outside the Usion host `window.Usion` is absent; the game detects that, hides
the invite button and plays the bot match, so the scene stays testable locally.

## Assets

`assets_raw/` holds the meshes exactly as generated (12 files, ~4.6 MB). They
are committed because regenerating them costs credits.

`npm run assets:compress` produces `public/models/`. The important step is
texture resizing: the generator emits 2048×2048 base-colour maps, which are only
~200 KB on disk but ~22 MB of VRAM *each* — twelve of those would break the
low-end phones this has to run on. The pipeline resizes to 512 px, re-encodes,
then meshopt-compresses geometry. Result: **4.63 MB → 1.13 MB**, and ~1.4 MB of
VRAM per texture.

Meshopt (not Draco) because three's `MeshoptDecoder` is bundled as a module, so
there is no extra wasm fetch at runtime.

## Deploy

Push to `main`. `.github/workflows/deploy.yml` typechecks, builds and publishes
to GitHub Pages.

The game is registered in the Usion service registry from the Usion monorepo
(`backend/scripts/seed_archers_arena.py`) — that script holds the registry
contract only; no game code lives in the platform repo.
