/**
 * Entry point: boots the renderer, wires the SDK, and runs the match loop.
 *
 * The view is over the local archer's shoulder, looking down-range, so the
 * camera is rebuilt every frame from the current aim — which is what makes
 * drawing the bow feel like leaning into the shot.
 *
 * Ordering note — the scene waits for a non-zero viewport (embedded WebViews
 * reveal the iframe late), but the network never does. Gating `connect()` on a
 * rendered frame is a known way to make a game silently never join.
 */

import './ui/styles.css';

import * as THREE from 'three';

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
import { CameraDirector } from './render/camera';
import type { ViewRequest } from './render/camera';
import { preload } from './render/models';
import type { ModelKey } from './render/models';
import { createScene, isWebGLAvailable, waitForViewport } from './render/scene';
import type { SceneHandles } from './render/scene';
import { facingOf, previewPath, simulateShot } from './sim';
import type { ArcherStats, HitZone, ShotInput, Vec3 } from './sim';
import { el } from './ui/dom';
import { Hud } from './ui/hud';
import { Menu } from './ui/menu';
import type { UsionConfig } from './usion';

const BOT_ID = '__bot__';
const AIM_BROADCAST_MS = 70;
/** Real flight times are slow to watch; nudge playback without losing weight. */
const PLAYBACK_SPEED = 1.25;
/** Beat before the bot starts lining up, so the camera arrives first. */
const BOT_THINK_MS = 700;
/** How long the bot spends visibly raising the bow and drawing before it fires. */
const BOT_AIM_MS = 1500;
const MIN_SHOT_MS = 300;
/** A hit knocks the target down; hold the turn until they are back up. */
const KNOCKDOWN_MS = 1650;
/** How long to wait for the host's INIT before assuming we are standalone. */
const INIT_TIMEOUT_MS = 2500;

type Phase = 'boot' | 'menu' | 'waiting' | 'playing' | 'over';

interface Playback {
  path: Vec3[];
  startedAt: number;
}

class Game {
  private readonly sceneMount = document.getElementById('scene') as HTMLElement;
  private readonly uiMount = document.getElementById('ui') as HTMLElement;

  private scene: SceneHandles | null = null;
  private readonly arenaView = new ArenaView();
  private rigs: [ArcherRig | null, ArcherRig | null] = [null, null];

  private readonly net: Net;
  private hud!: Hud;
  private menu!: Menu;
  private uiBuilt = false;
  private hosted = false;
  private aimController: AimController | null = null;

  private profile: Profile = defaultProfile();
  private state: MatchState = emptyMatch();
  private phase: Phase = 'boot';

  private mySeat: Seat = 0;
  private vsBot = false;
  private botMemory = createBotMemory();
  private botTimer = 0;
  /** The bot's committed shot, animated toward before it is actually fired. */
  private botAim: { shot: ShotInput; startedAt: number; fromPitch: number } | null = null;
  /** Elevation the opponent is currently showing, for their rig and the camera. */
  private opponentPitch = 0.25;

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
  private aim: ShotInput = { pitch: 0.25, power: 0.5 };
  private remoteAim: { seat: Seat; pitch: number } | null = null;
  private readonly cameraDirector = new CameraDirector();
  private readonly cameraOrigin = new THREE.Vector3();
  private readonly sunAnchor = new THREE.Vector3();
  private readonly arrowAt = new THREE.Vector3();
  private readonly arrowHeading = new THREE.Vector3();
  private lastFrameAt = 0;

  constructor() {
    this.net = new Net({
      onAction: (message) => this.handleAction(message),
      onRealtime: (message) => this.handleRealtime(message),
      onSync: (data) => this.handleSync(data),
      onPlayerJoined: (roster) => this.handleRoster(roster),
      onPlayerLeft: (roster) => this.handlePlayerLeft(roster),
      onRoomAssigned: (roomId) => void this.joinRoom(roomId),
      onConnectionChange: (online) => this.hud?.setReconnecting(!online),
    });
  }

  // ------------------------------------------------------------------ boot

  private buildUi(): void {
    if (this.uiBuilt) return;
    this.uiBuilt = true;

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

  /**
   * `window.Usion` exists even with no host around it — the SDK script defines
   * it unconditionally — and `init(cb)` fires ONLY when the host posts INIT.
   * So branching on `if (window.Usion)` waits forever outside the host.
   * Race the host's INIT against a short timer and boot whichever wins.
   */
  async boot(): Promise<void> {
    const sdk = window.Usion;
    let settled = false;
    let timer = 0;

    const startHosted = (config: UsionConfig): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      this.hosted = true;
      setLanguage(config.language);
      this.buildUi();
      this.net.registerHandlers(config);
      void this.afterInit(config.roomId ?? null, config.playerIds ?? []);
    };

    const startStandalone = (): void => {
      if (settled) return;
      settled = true;
      this.hosted = false;
      setLanguage(navigator.language);
      this.buildUi();
      void this.afterInit(null, []);
    };

    if (!sdk) {
      startStandalone();
      return;
    }

    timer = window.setTimeout(startStandalone, INIT_TIMEOUT_MS);
    try {
      sdk.init(startHosted);
    } catch (error) {
      console.warn('[archers-arena] Usion.init threw', error);
      startStandalone();
    }
  }

  private async afterInit(roomId: string | null, playerIds: string[]): Promise<void> {
    document.title = t('app.title');
    this.menu.setInviteAvailable(this.hosted);

    // Branch on the mode the HOST declares, never on whether a roomId exists:
    // a solo launch from Explore can still carry an auto-created room, and
    // joining it stranded the player on 'waiting for opponent' with no way to
    // reach the menu or the bot. A solo launch that is later promoted arrives
    // through onRoomAssigned instead.
    const launchRoom =
      this.hosted && this.net.isMultiplayer()
        ? (roomId ?? this.net.launchParams().roomId ?? null)
        : null;

    // Join and boot the renderer concurrently — never gate the join on a frame.
    const joining = launchRoom ? this.joinRoom(launchRoom) : Promise.resolve();
    const rendering = this.startRenderer();

    this.profile = await loadProfile();
    this.menu.setProfile(this.profile);

    // The menu needs no renderer, and waiting for one costs up to 4 s while a
    // slow host reveals the iframe. Show it as soon as the profile is in.
    if (!launchRoom) this.showMenu();

    await Promise.all([rendering, joining]);

    if (launchRoom) {
      this.handleRoster(playerIds.length ? playerIds : this.net.roster);
    }
  }

  private async startRenderer(): Promise<void> {
    if (!isWebGLAvailable()) {
      this.showFatal(t('app.unsupported'), t('app.unsupportedHint'));
      return;
    }
    try {
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

      await preload(['archer_hero', 'bow', 'arrow', 'quiver']);
      requestAnimationFrame(this.frame);
    } catch (error) {
      // Losing the renderer must not take the menu down with it.
      console.error('[archers-arena] renderer failed to start', error);
      this.showFatal(t('app.unsupported'), t('app.unsupportedHint'));
    }
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
    if (joined) {
      this.handleRoster(this.net.roster);
      return;
    }
    // A failed join used to leave the player on 'waiting for opponent' forever
    // with nothing to press. Fall back to the menu so the bot is still there.
    console.warn('[archers-arena] could not join', roomId);
    this.vsBot = false;
    this.phase = 'menu';
    this.showMenu();
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

  private handleAction(message: {
    player_id: string;
    action_type: string;
    action_data: any;
    sequence?: number;
  }): void {
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

  private handleRealtime(message: {
    player_id: string;
    action_type: string;
    action_data: any;
  }): void {
    if (message.action_type !== 'aim') return;
    const seat = this.seatOf(message.player_id);
    if (seat === null || seat === this.mySeat) return;
    const pitch = Number(message.action_data?.pitch) || 0;
    this.remoteAim = { seat, pitch };
    this.opponentPitch = pitch;
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
    this.botAim = null;
    this.opponentPitch = 0.25;
    this.readyStats.clear();
    this.readySent = false;
    this.state = emptyMatch();
    this.animatedSequence = 0;
    this.localSequence = 0;
    this.resultReported = false;
    this.playback = null;
    this.remoteAim = null;
    this.aim = { pitch: 0.25, power: 0.5 };
    this.aimController?.resetPitch(0.25);
    this.arenaView.hideArrow();
    this.arenaView.hideTracer();
    this.hud.hideResult();
    this.hud.setPower(null);
    this.hud.setElevation(0.25);
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
      // Scenery must never gate the match. Every caller invokes this as
      // `void onStateChanged()`, so a throw here would vanish into an
      // unhandled rejection and the turn would never be handed to anyone.
      try {
        await this.buildArena();
      } catch (error) {
        console.error('[archers-arena] arena build failed, playing anyway', error);
      }
    }

    const arena = arenaByIndex(this.state.arenaIndex);
    this.hud.setArena(arena.nameKey, arena.wind);
    this.refreshHealth();

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
    this.aimController?.setEnabled(mine);
    if (mine) this.rigs[this.mySeat]?.nock();

    window.clearTimeout(this.botTimer);
    if (this.vsBot && this.state.turn === 1) {
      this.botTimer = window.setTimeout(() => this.takeBotTurn(), BOT_THINK_MS);
    }
  }

  private takeBotTurn(): void {
    if (!this.vsBot || this.state.over || this.state.turn !== 1) return;
    const arena = arenaByIndex(this.state.arenaIndex);
    const shot = chooseBotShot(arena, archersFor(this.state), 1, arena.botSkill, this.botMemory);
    // Firing here would be instant and unreadable — the shot is committed now
    // but held until the archer has visibly lined it up (see the frame loop).
    this.botAim = { shot, startedAt: performance.now(), fromPitch: this.opponentPitch };
  }

  /** Drive the bot's aim animation, and fire once it has finished lining up. */
  private advanceBotAim(now: number): void {
    if (!this.botAim) return;
    if (this.state.over || this.state.turn !== 1) {
      this.botAim = null;
      return;
    }

    const t = Math.min(1, (now - this.botAim.startedAt) / BOT_AIM_MS);
    const eased = t * t * (3 - 2 * t);
    this.opponentPitch =
      this.botAim.fromPitch + (this.botAim.shot.pitch - this.botAim.fromPitch) * eased;

    const rig = this.rigs[1];
    rig?.setAim(this.opponentPitch);
    // The draw fills a little ahead of the aim, so the release lands on a
    // fully drawn bow rather than a still-rising one.
    rig?.setDraw(Math.min(1, t * 1.2) * this.botAim.shot.power);

    if (t < 1 || this.playback) return;
    const shot = this.botAim.shot;
    this.botAim = null;
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

    const archers = archersFor(this.state);
    for (const seat of [0, 1] as Seat[]) {
      const options = {
        // A properly rigged CC0 character with authored clips — idle, aim,
        // shoot, hit and death. Its own animation does the acting; nothing
        // here poses bones by hand.
        model: 'archer_hero' as ModelKey,
        facing: facingOf(seat),
        tint: seat === 0 ? 0xd6503f : 0x3f6ed6,
      };
      const rig = new ArcherRig(options);
      await rig.load(options);
      rig.group.position.set(archers[seat].pos.x, archers[seat].pos.y, archers[seat].pos.z);
      this.scene?.root.add(rig.group);
      this.rigs[seat] = rig;
    }

    const opponentName = this.vsBot ? 'Bot' : t('hud.opponent');
    this.hud.setNames(t('hud.you'), opponentName);
    this.refreshHealth();
    this.cameraDirector.snap();
  }

  private refreshHealth(): void {
    const foe: Seat = this.mySeat === 0 ? 1 : 0;
    this.hud.setHealth('you', this.state.health[this.mySeat], this.state.stats[this.mySeat].maxHealth);
    this.hud.setHealth('foe', this.state.health[foe], this.state.stats[foe].maxHealth);
  }

  // -------------------------------------------------------------- shooting

  private handleAiming(aim: ShotInput): void {
    if (this.state.turn !== this.mySeat || this.state.over || this.playback) return;

    this.aim = aim;
    this.rigs[this.mySeat]?.setAim(aim.pitch);
    this.rigs[this.mySeat]?.setDraw(aim.power);
    this.hud.setPower(aim.power);
    this.hud.setElevation(aim.pitch);

    const arena = arenaByIndex(this.state.arenaIndex);
    const archers = archersFor(this.state);
    this.arenaView.showTracer(
      previewPath(arena, archers[this.mySeat], facingOf(this.mySeat), aim),
      0xffffff,
    );

    const now = performance.now();
    if (!this.vsBot && now - this.lastAimSent > AIM_BROADCAST_MS) {
      this.lastAimSent = now;
      this.net.sendRealtime('aim', { pitch: aim.pitch });
    }
  }

  private cancelAim(): void {
    this.hud.setPower(null);
    this.arenaView.hideTracer();
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
    this.rigs[seat]?.setAim(input.pitch);
    this.rigs[seat]?.release();
    this.arenaView.clearTrail();
    this.remoteAim = null;
    if (seat === this.mySeat) this.hud.setElevation(input.pitch);

    this.playback = { path: result.path, startedAt: performance.now() };

    const flightMs = (result.flightTime * 1000) / PLAYBACK_SPEED;
    window.setTimeout(
      () => {
        // Leave the shaft standing where it landed so the miss is readable.
        const path = result.path;
        const last = path[path.length - 1] ?? null;
        const before = path[path.length - 2] ?? null;
        this.playback = null;
        this.arenaView.hideArrow();
        if (last) this.arenaView.stickArrow(last, before);
        if (zone) this.rigs[seat === 0 ? 1 : 0]?.knockDown();
        this.hud.showShotResult(zone, damage, blocked);
        this.refreshHealth();

        if (this.vsBot && seat === 1) {
          recordBotOutcome(this.botMemory, result.path, archers[0], facingOf(1));
        }

        // Let the knockdown play out before the next turn starts, so nobody
        // draws a bow while flat on their back.
        if (zone) window.setTimeout(() => this.refreshTurn(), KNOCKDOWN_MS);
        else this.refreshTurn();
      },
      Math.max(MIN_SHOT_MS, flightMs),
    );
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
      if (this.hosted) {
        this.net.exit();
        return;
      }
    }
    this.showMenu();
  }

  private showMenu(): void {
    // Never wipe a match that is already under way — boot finishes late on a
    // slow host, and it must not stomp a game the player already started.
    if (this.state.started && !this.state.over) return;
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

    const dt = this.lastFrameAt ? Math.min(0.1, (now - this.lastFrameAt) / 1000) : 1 / 60;
    this.lastFrameAt = now;
    this.advanceBotAim(now);
    this.rigs[0]?.update(now, dt);
    this.rigs[1]?.update(now, dt);

    if (this.remoteAim && !this.vsBot) {
      this.rigs[this.remoteAim.seat]?.setAim(this.remoteAim.pitch);
      this.rigs[this.remoteAim.seat]?.setDraw(0.7);
    }

    let followingArrow = false;
    if (this.playback) {
      const elapsed = ((now - this.playback.startedAt) / 1000) * PLAYBACK_SPEED;
      const index = Math.min(this.playback.path.length - 1, Math.floor(elapsed * 120));
      const point = this.playback.path[index];
      const before = this.playback.path[Math.max(0, index - 1)] ?? null;
      if (point) {
        this.arenaView.setArrow(point, before);
        if (index % 3 === 0) this.arenaView.pushTrail(point);
        this.arrowAt.set(point.x, point.y, point.z);
        this.arrowHeading.set(
          point.x - (before?.x ?? point.x),
          point.y - (before?.y ?? point.y),
          point.z - (before?.z ?? point.z),
        );
        followingArrow = true;
      }
    }

    if (this.state.started) {
      const archers = archersFor(this.state);
      let view: ViewRequest;

      if (followingArrow) {
        view = { kind: 'flight', at: this.arrowAt, heading: this.arrowHeading };
        this.sunAnchor.copy(this.arrowAt);
      } else {
        // Stand behind whoever is about to shoot, so the opponent's turn is
        // watched from their shoulder rather than from across the range.
        const seat: Seat = this.state.over ? this.mySeat : this.state.turn;
        const archer = archers[seat];
        const mine = seat === this.mySeat;
        this.cameraOrigin.set(archer.pos.x, archer.pos.y, archer.pos.z);
        // Your own turn is played over your shoulder; the opponent's is watched
        // from in front of them, so you see the bow come up and the draw build.
        view = {
          kind: mine ? 'shoulder' : 'approach',
          seat,
          origin: this.cameraOrigin,
          // Always the VIEWER's facing: the approach flies down your own sight
          // line toward the opponent instead of swinging around behind them.
          facing: facingOf(this.mySeat),
          pitch: mine ? this.aim.pitch : this.opponentPitch,
        };
        this.sunAnchor.set(archer.pos.x, 0, archer.pos.z + 20 * facingOf(seat));
      }

      const placement = this.cameraDirector.update(view, dt);
      scene.setCamera(placement.eye, placement.focus, this.sunAnchor);
    }

    scene.render();
  };
}

if (document.getElementById('app')) {
  void new Game().boot();
}
