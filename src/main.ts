/**
 * Entry point: boots the renderer, wires the SDK, and runs the match loop.
 *
 * Ordering note — the scene waits for a non-zero viewport (embedded WebViews
 * reveal the iframe late), but the network never does. Gating `connect()` on a
 * rendered frame is a known way to make a game silently never join.
 */

import './ui/styles.css';

import { arenaByIndex, highestUnlockedArena } from './arenas';
import { chooseBotShot, createBotMemory, recordBotOutcome } from './bot';
import { setLanguage, t } from './i18n';
import { AimController } from './input';
import { applyAction, archersFor, emptyMatch, replay } from './match';
import type { MatchAction, MatchState, Seat } from './match';
import { Net } from './net';
import {
  buyUpgrade,
  defaultProfile,
  loadProfile,
  saveProfile,
  settleMatch,
  statsFor,
} from './progression';
import type { Profile, UpgradeTrack } from './progression';
import { ArcherRig } from './render/archer';
import { ArenaView } from './render/arena3d';
import { preload } from './render/models';
import type { ModelKey } from './render/models';
import { createScene, isWebGLAvailable, waitForViewport } from './render/scene';
import type { SceneHandles } from './render/scene';
import { previewPath, simulateShot } from './sim';
import type { ArcherStats, HitZone, ShotInput, Vec2 } from './sim';
import { el } from './ui/dom';
import { Hud } from './ui/hud';
import { Menu } from './ui/menu';

const BOT_ID = '__bot__';
const AIM_BROADCAST_MS = 70;
/** Real flight times are slow to watch; nudge playback without losing weight. */
const PLAYBACK_SPEED = 1.35;
const BOT_THINK_MS = 900;
const MIN_SHOT_MS = 260;

type Phase = 'boot' | 'menu' | 'waiting' | 'playing' | 'over';

interface Playback {
  path: Vec2[];
  startedAt: number;
}

class Game {
  private readonly sceneMount = document.getElementById('scene') as HTMLElement;
  private readonly uiMount = document.getElementById('ui') as HTMLElement;

  private scene: SceneHandles | null = null;
  private readonly arenaView = new ArenaView();
  private rigs: [ArcherRig | null, ArcherRig | null] = [null, null];

  private readonly net: Net;
  private readonly hud: Hud;
  private readonly menu: Menu;
  private aimController: AimController | null = null;

  private profile: Profile = defaultProfile();
  private state: MatchState = emptyMatch();
  private phase: Phase = 'boot';

  private mySeat: Seat = 0;
  private vsBot = false;
  private botMemory = createBotMemory();
  private botTimer = 0;

  private readonly readyStats = new Map<string, ArcherStats>();
  private readySent = false;
  private localSequence = 0;
  private lastAimSent = 0;
  private animatedSequence = 0;
  private ratingBefore = 0;
  private cashBefore = 0;
  private resultReported = false;
  private builtArenaIndex = -1;

  private playback: Playback | null = null;
  private remoteAim: { seat: Seat; angle: number } | null = null;

  constructor() {
    this.net = new Net({
      onAction: (message) => this.handleAction(message),
      onRealtime: (message) => this.handleRealtime(message),
      onSync: (data) => this.handleSync(data),
      onPlayerJoined: (roster) => this.handleRoster(roster),
      onPlayerLeft: (roster) => this.handlePlayerLeft(roster),
      onRoomAssigned: (roomId) => void this.joinRoom(roomId),
      onConnectionChange: (online) => this.hud.setReconnecting(!online),
    });

    this.hud = new Hud({
      onAgain: () => void this.restart(),
      onExit: () => this.leave(),
    });

    this.menu = new Menu({
      onPractice: () => void this.startBotMatch(),
      onInvite: () => void this.net.invite(),
      onBuy: (track) => void this.purchase(track),
    });
    this.menu.onRecordsModeChange((mode) => void this.refreshRecords(mode));

    this.uiMount.append(this.menu.root, this.hud.root);
  }

  // ------------------------------------------------------------------ boot

  async boot(): Promise<void> {
    const sdk = window.Usion;
    if (!sdk) {
      // Standalone (`npm run dev`): no host, so offer the bot game only.
      setLanguage(navigator.language);
      await this.startRenderer();
      this.profile = await loadProfile();
      this.menu.setInviteAvailable(false);
      this.showMenu();
      return;
    }

    sdk.init((config) => {
      setLanguage(config.language);
      this.net.registerHandlers(config);
      void this.afterInit(config.roomId ?? null, config.playerIds ?? []);
    });
  }

  private async afterInit(roomId: string | null, playerIds: string[]): Promise<void> {
    document.title = t('app.title');
    this.menu.setInviteAvailable(this.net.embedded);

    const launchRoom = roomId ?? this.net.launchParams().roomId ?? null;

    // Join and boot the renderer concurrently — never gate the join on a frame.
    const joining = launchRoom ? this.joinRoom(launchRoom) : Promise.resolve();
    const [loaded] = await Promise.all([loadProfile(), this.startRenderer(), joining]);
    this.profile = loaded;
    this.menu.setProfile(this.profile);

    if (!launchRoom) {
      this.showMenu();
    } else {
      this.handleRoster(playerIds.length ? playerIds : this.net.roster);
    }
  }

  private async startRenderer(): Promise<void> {
    if (!isWebGLAvailable()) {
      this.showFatal(t('app.unsupported'), t('app.unsupportedHint'));
      return;
    }
    const viewport = await waitForViewport(this.sceneMount);
    const scene = createScene(this.sceneMount, viewport);
    scene.root.add(this.arenaView.group);
    this.scene = scene;

    this.aimController = new AimController(scene.renderer.domElement, {
      onStart: () => this.rigs[this.mySeat]?.nock(),
      onMove: (aim) => this.handleAiming(aim),
      onRelease: (aim) => void this.fire(aim),
      onCancel: () => this.cancelAim(),
    });

    await preload(['archer_a', 'archer_b', 'bow', 'arrow']);
    requestAnimationFrame(this.frame);
  }

  private showFatal(title: string, hint: string): void {
    const veil = el('div', 'veil');
    veil.append(el('h1', '', title), el('div', 'reward', hint));
    this.uiMount.append(veil);
  }

  // ----------------------------------------------------------------- rooms

  private async joinRoom(roomId: string): Promise<void> {
    this.vsBot = false;
    this.phase = 'waiting';
    this.menu.setVisible(false);
    this.hud.setVisible(true);
    this.hud.setTurn(false, true);
    const joined = await this.net.connectAndJoin(roomId);
    if (joined) this.handleRoster(this.net.roster);
  }

  private seatOf(playerId: string): Seat | null {
    if (this.vsBot) {
      if (playerId === BOT_ID) return 1;
      return playerId === this.net.myId() ? 0 : null;
    }
    const index = this.net.roster.indexOf(playerId);
    return index === 0 || index === 1 ? (index as Seat) : null;
  }

  private handleRoster(roster: string[]): void {
    if (this.vsBot) return;
    const index = roster.indexOf(this.net.myId());
    this.mySeat = index === 1 ? 1 : 0;

    if (roster.length < 2) {
      this.phase = 'waiting';
      this.hud.setTurn(false, true);
      return;
    }
    if (this.state.started || this.readySent) {
      this.maybeStartMatch();
      return;
    }

    // Everyone announces their own upgraded stats; the host locks the match.
    this.readySent = true;
    void this.net.sendAction('ready', { stats: statsFor(this.profile.upgrades) });
  }

  private maybeStartMatch(): void {
    if (this.state.started || this.vsBot) return;
    const roster = this.net.roster;
    if (roster.length < 2 || roster[0] !== this.net.myId()) return;

    const first = this.readyStats.get(roster[0]);
    const second = this.readyStats.get(roster[1]);
    if (!first || !second) return;

    void this.net.sendAction('start', {
      arenaIndex: highestUnlockedArena(this.profile.rating),
      stats: [first, second],
    });
  }

  private handlePlayerLeft(roster: string[]): void {
    if (this.vsBot || !this.state.started || this.state.over) return;
    if (roster.length >= 2) return;
    // The opponent is gone for good — take the win rather than freeze.
    this.state = { ...this.state, over: true, winner: this.mySeat };
    void this.finishMatch(true);
  }

  // --------------------------------------------------------------- actions

  private handleAction(message: { player_id: string; action_type: string; action_data: any; sequence?: number }): void {
    if (message.action_type === 'ready') {
      const stats = message.action_data?.stats;
      if (stats) this.readyStats.set(message.player_id, stats);
      this.maybeStartMatch();
      return;
    }

    this.localSequence = Math.max(this.localSequence, Number(message.sequence) || 0);
    const action: MatchAction = {
      playerId: message.player_id,
      type: message.action_type,
      data: message.action_data,
      sequence: Number(message.sequence) || ++this.localSequence,
    };
    this.state = applyAction(this.state, action, (id) => this.seatOf(id));
    void this.onStateChanged();
  }

  private handleRealtime(message: { player_id: string; action_type: string; action_data: any }): void {
    if (message.action_type !== 'aim') return;
    const seat = this.seatOf(message.player_id);
    if (seat === null || seat === this.mySeat) return;
    this.remoteAim = { seat, angle: Number(message.action_data?.angle) || 0 };
  }

  private handleSync(data: any): void {
    if (!Array.isArray(data?.actions)) return;

    const actions: MatchAction[] = [];
    for (const raw of data.actions) {
      if (raw?.action_type === 'ready') {
        if (raw.action_data?.stats) this.readyStats.set(raw.player_id, raw.action_data.stats);
        continue;
      }
      actions.push({
        playerId: raw.player_id,
        type: raw.action_type,
        data: raw.action_data,
        sequence: Number(raw.sequence) || 0,
      });
    }

    this.state = replay(actions, (id) => this.seatOf(id));
    // A rejoin must not replay every shot that already happened.
    this.animatedSequence = this.state.lastShot?.sequence ?? 0;
    this.localSequence = Math.max(this.localSequence, this.state.appliedSequence);
    void this.onStateChanged();
  }

  // ----------------------------------------------------------------- match

  private async startBotMatch(): Promise<void> {
    this.vsBot = true;
    this.mySeat = 0;
    this.botMemory = createBotMemory();
    this.resetMatchBookkeeping();

    const arenaIndex = highestUnlockedArena(this.profile.rating);
    const arena = arenaByIndex(arenaIndex);
    const mine = statsFor(this.profile.upgrades);
    // The bot fights with stats scaled to the arena, so deeper ladders bite.
    const theirs: ArcherStats = {
      maxHealth: Math.round(mine.maxHealth * (0.85 + arena.botSkill * 0.3)),
      baseDamage: Math.round(mine.baseDamage * (0.8 + arena.botSkill * 0.35)),
      headshotDamage: Math.round(mine.headshotDamage * (0.8 + arena.botSkill * 0.35)),
    };

    this.menu.setVisible(false);
    this.hud.setVisible(true);
    this.applyLocalAction('start', { arenaIndex, stats: [mine, theirs] }, this.net.myId());
  }

  private resetMatchBookkeeping(): void {
    window.clearTimeout(this.botTimer);
    this.readyStats.clear();
    this.readySent = false;
    this.state = emptyMatch();
    this.animatedSequence = 0;
    this.localSequence = 0;
    this.resultReported = false;
    this.playback = null;
    this.remoteAim = null;
    this.arenaView.hideArrow();
    this.arenaView.hideGuide();
    this.hud.hideResult();
    this.hud.setPower(null);
  }

  private applyLocalAction(type: string, data: unknown, playerId: string): void {
    this.localSequence += 1;
    this.state = applyAction(
      this.state,
      { playerId, type, data, sequence: this.localSequence },
      (id) => this.seatOf(id),
    );
    void this.onStateChanged();
  }

  private async onStateChanged(): Promise<void> {
    if (!this.state.started) return;

    if (this.phase !== 'playing' && this.phase !== 'over') {
      this.phase = 'playing';
      this.ratingBefore = this.profile.rating;
      this.cashBefore = this.profile.cash;
    }

    if (this.builtArenaIndex !== this.state.arenaIndex) {
      await this.buildArena();
    }

    const arena = arenaByIndex(this.state.arenaIndex);
    this.hud.setArena(arena.nameKey, arena.wind);
    this.updateHealthPlates();

    const shot = this.state.lastShot;
    if (shot && shot.sequence > this.animatedSequence) {
      this.animatedSequence = shot.sequence;
      this.playShot(shot.seat, shot.input, shot.zone, shot.damage, shot.blocked);
      return;
    }

    this.refreshTurn();
  }

  private refreshTurn(): void {
    if (this.state.over) {
      void this.finishMatch(false);
      return;
    }

    const mine = this.state.turn === this.mySeat;
    this.hud.setTurn(mine, false);
    this.aimController?.setEnabled(mine, this.mySeat === 0 ? 1 : -1);
    this.rigs[this.state.turn]?.nock();
    this.rigs[0]?.setActive(this.state.turn === 0);
    this.rigs[1]?.setActive(this.state.turn === 1);

    window.clearTimeout(this.botTimer);
    if (this.vsBot && this.state.turn === 1) {
      this.botTimer = window.setTimeout(() => this.takeBotTurn(), BOT_THINK_MS);
    }
  }

  private takeBotTurn(): void {
    if (!this.vsBot || this.state.over || this.state.turn !== 1) return;
    const arena = arenaByIndex(this.state.arenaIndex);
    const shot = chooseBotShot(arena, archersFor(this.state), 1, arena.botSkill, this.botMemory);
    this.applyLocalAction('shoot', shot, BOT_ID);
  }

  private async buildArena(): Promise<void> {
    const arena = arenaByIndex(this.state.arenaIndex);
    this.builtArenaIndex = this.state.arenaIndex;
    this.scene?.setPalette(arena.palette);

    await preload(arena.props.map((prop) => prop.model as ModelKey));
    await this.arenaView.build(arena);

    for (const rig of this.rigs) {
      if (!rig) continue;
      this.scene?.root.remove(rig.group);
      rig.dispose();
    }
    this.rigs = [null, null];

    const opponentName = this.vsBot ? 'Bot' : t('hud.opponentTurn');
    const names: [string, string] =
      this.mySeat === 0 ? [this.net.myName(), opponentName] : [opponentName, this.net.myName()];

    for (const seat of [0, 1] as Seat[]) {
      const options = {
        model: (seat === 0 ? 'archer_a' : 'archer_b') as 'archer_a' | 'archer_b',
        facing: (seat === 0 ? 1 : -1) as 1 | -1,
        name: names[seat],
        accent: seat === 0 ? 0xf87171 : 0x60a5fa,
      };
      const rig = new ArcherRig(options);
      await rig.load(options);
      rig.group.position.set(arena.spawn[seat].x, arena.spawn[seat].y, 0);
      this.scene?.root.add(rig.group);
      this.rigs[seat] = rig;
    }

    this.scene?.frameArena(
      Math.min(arena.spawn[0].x, arena.spawn[1].x) - 3,
      Math.max(arena.spawn[0].x, arena.spawn[1].x) + 3,
      Math.max(arena.spawn[0].y, arena.spawn[1].y) + 4,
    );
    this.updateHealthPlates();
  }

  private updateHealthPlates(): void {
    this.rigs[0]?.setHealth(this.state.health[0], this.state.stats[0]);
    this.rigs[1]?.setHealth(this.state.health[1], this.state.stats[1]);
  }

  // -------------------------------------------------------------- shooting

  private handleAiming(aim: ShotInput): void {
    if (this.state.turn !== this.mySeat || this.state.over || this.playback) return;

    const rig = this.rigs[this.mySeat];
    rig?.setAim(aim.angle);
    rig?.setDraw(aim.power);
    this.hud.setPower(aim.power);

    const arena = arenaByIndex(this.state.arenaIndex);
    const archers = archersFor(this.state);
    this.arenaView.showGuide(
      previewPath(arena, archers[this.mySeat], aim),
      this.mySeat === 0 ? 0xfca5a5 : 0x93c5fd,
    );

    const now = performance.now();
    if (!this.vsBot && now - this.lastAimSent > AIM_BROADCAST_MS) {
      this.lastAimSent = now;
      this.net.sendRealtime('aim', { angle: aim.angle });
    }
  }

  private cancelAim(): void {
    this.hud.setPower(null);
    this.arenaView.hideGuide();
    this.rigs[this.mySeat]?.setDraw(0);
  }

  private async fire(aim: ShotInput): Promise<void> {
    if (this.state.turn !== this.mySeat || this.state.over || this.playback) {
      this.cancelAim();
      return;
    }
    this.cancelAim();
    this.aimController?.setEnabled(false);

    if (this.vsBot) {
      this.applyLocalAction('shoot', aim, this.net.myId());
    } else {
      // Applied when it comes back through onAction, never optimistically.
      await this.net.sendAction('shoot', aim);
    }
  }

  private playShot(
    seat: Seat,
    input: ShotInput,
    zone: HitZone | null,
    damage: number,
    blocked: boolean,
  ): void {
    // The trajectory is a pure function of the arena and the shot, so both
    // players — and one who just rejoined — watch the identical arrow.
    const arena = arenaByIndex(this.state.arenaIndex);
    const archers = archersFor(this.state);
    const result = simulateShot(arena, archers, seat, input);

    this.aimController?.setEnabled(false);
    this.rigs[seat]?.setAim(input.angle);
    this.rigs[seat]?.release();
    this.arenaView.clearTrail();
    this.remoteAim = null;

    this.playback = { path: result.path, startedAt: performance.now() };

    const flightMs = (result.flightTime * 1000) / PLAYBACK_SPEED;
    window.setTimeout(() => {
      this.playback = null;
      this.arenaView.hideArrow();
      if (zone) this.rigs[seat === 0 ? 1 : 0]?.flashHit();
      this.hud.showShotResult(zone, damage, blocked);
      this.updateHealthPlates();

      if (this.vsBot && seat === 1) {
        recordBotOutcome(this.botMemory, result.path, archers[0], -1);
      }
      this.refreshTurn();
    }, Math.max(MIN_SHOT_MS, flightMs));
  }

  // ---------------------------------------------------------------- ending

  private async finishMatch(forfeit: boolean): Promise<void> {
    if (this.phase === 'over') return;
    this.phase = 'over';
    this.aimController?.setEnabled(false);
    window.clearTimeout(this.botTimer);

    const won = this.state.winner === this.mySeat;
    const ratingBefore = this.ratingBefore || this.profile.rating;
    const cashBefore = this.cashBefore;

    this.profile = settleMatch(this.profile, won, this.state.arenaIndex);
    await saveProfile(this.profile);
    this.menu.setProfile(this.profile);
    void this.net.submitRating(this.profile.rating);

    // Host reports once so the platform drops result cards into the chat.
    if (!this.vsBot && !this.resultReported && this.net.roster[0] === this.net.myId()) {
      this.resultReported = true;
      const winnerSeat = this.state.winner ?? 0;
      const winnerId = this.net.roster[winnerSeat];
      const scores: Record<string, number> = {};
      this.net.roster.slice(0, 2).forEach((id, seat) => {
        scores[id] = this.state.health[seat as Seat];
      });
      if (winnerId) {
        this.net.reportResult(
          winnerId,
          scores,
          `${this.state.health[0]} : ${this.state.health[1]}`,
        );
      }
    }

    this.hud.setRematchEnabled(this.vsBot || this.net.roster.length >= 2);
    this.hud.showResult(
      won,
      forfeit,
      this.profile.cash - cashBefore,
      this.profile.rating - ratingBefore,
    );
  }

  private async restart(): Promise<void> {
    this.phase = 'menu';
    this.builtArenaIndex = -1;
    if (this.vsBot) {
      await this.startBotMatch();
      return;
    }
    this.resetMatchBookkeeping();
    this.handleRoster(this.net.roster);
  }

  private leave(): void {
    this.hud.hideResult();
    this.hud.setVisible(false);
    if (!this.vsBot) {
      this.net.leave();
      if (this.net.embedded) {
        this.net.exit();
        return;
      }
    }
    this.showMenu();
  }

  private showMenu(): void {
    this.phase = 'menu';
    this.builtArenaIndex = -1;
    this.resetMatchBookkeeping();
    this.menu.setProfile(this.profile);
    this.menu.setVisible(true);
    this.hud.setVisible(false);
    void this.refreshRecords(this.menu.activeRecordsMode);
  }

  private async purchase(track: UpgradeTrack): Promise<void> {
    const next = buyUpgrade(this.profile, track);
    if (next === this.profile) return;
    this.profile = next;
    this.menu.setProfile(this.profile);
    await saveProfile(this.profile);
  }

  private async refreshRecords(mode: 'friends' | 'global'): Promise<void> {
    this.menu.setRecords(await this.net.records(mode));
  }

  // ------------------------------------------------------------------ loop

  private readonly frame = (now: number): void => {
    requestAnimationFrame(this.frame);
    const scene = this.scene;
    if (!scene) return;

    this.rigs[0]?.update(now);
    this.rigs[1]?.update(now);

    if (this.remoteAim) {
      this.rigs[this.remoteAim.seat]?.setAim(this.remoteAim.angle);
      this.rigs[this.remoteAim.seat]?.setDraw(0.7);
    }

    if (this.playback) {
      const elapsed = ((now - this.playback.startedAt) / 1000) * PLAYBACK_SPEED;
      const index = Math.min(this.playback.path.length - 1, Math.floor(elapsed * 120));
      const point = this.playback.path[index];
      if (point) {
        this.arenaView.setArrow(point, this.playback.path[Math.max(0, index - 1)] ?? null);
        if (index % 4 === 0) this.arenaView.pushTrail(point);
      }
    }

    scene.render();
  };
}

if (document.getElementById('app')) {
  void new Game().boot();
}
