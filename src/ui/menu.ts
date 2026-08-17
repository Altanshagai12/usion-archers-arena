/**
 * Home, upgrades and records.
 *
 * Deliberately three plain screens with one obvious action each — a first-time
 * player should be able to start a match without reading anything. Room codes,
 * matchmaking and the friend picker are the platform's job, so "Invite a
 * friend" just calls `Usion.game.invite()` and the host takes over.
 */

import { ARENAS, highestUnlockedArena } from '../arenas';
import { formatNumber, t } from '../i18n';
import {
  MAX_UPGRADE_LEVEL,
  rankTitleKey,
  trackValue,
  upgradeCost,
} from '../progression';
import type { Profile, UpgradeTrack } from '../progression';
import type { LeaderboardEntry } from '../usion';
import { button, clear, el, show } from './dom';

export interface MenuCallbacks {
  onPractice(): void;
  onInvite(): void;
  onBuy(track: UpgradeTrack): void;
}

const TRACKS: Array<{ track: UpgradeTrack; labelKey: string }> = [
  { track: 'health', labelKey: 'upgrade.health' },
  { track: 'damage', labelKey: 'upgrade.damage' },
  { track: 'headshot', labelKey: 'upgrade.headshot' },
];

export class Menu {
  readonly root = el('div', 'screen');

  private readonly home = el('div', 'stack');
  private readonly upgrades = el('div', 'stack');
  private readonly records = el('div', 'stack');

  private readonly ratingValue = el('div', 'value');
  private readonly cashValue = el('div', 'value');
  private readonly recordValue = el('div', 'value');
  private readonly rankLabel = el('h2');
  private readonly arenaLabel = el('div', 'hint');
  private readonly upgradeList = el('div', 'stack');
  private readonly upgradeCash = el('h2');
  private readonly recordList = el('div', 'stack');
  private readonly friendsTab: HTMLButtonElement;
  private readonly globalTab: HTMLButtonElement;

  private readonly callbacks: MenuCallbacks;
  private inviteButton: HTMLButtonElement;
  private profile: Profile | null = null;
  private recordsMode: 'friends' | 'global' = 'friends';
  private onRecordsMode: ((mode: 'friends' | 'global') => void) | null = null;

  constructor(callbacks: MenuCallbacks) {
    this.callbacks = callbacks;
    this.root.hidden = true;

    // --- home ---
    const title = el('h1', '', t('app.title'));
    this.rankLabel.textContent = '';

    const stats = el('div', 'stat-row');
    stats.append(
      this.stat(t('menu.rating'), this.ratingValue),
      this.stat(t('menu.cash'), this.cashValue),
      this.stat(t('menu.record', { wins: '', losses: '' }).trim() || 'W/L', this.recordValue),
    );

    this.inviteButton = button('primary', t('menu.invite'), callbacks.onInvite);
    this.home.append(
      title,
      this.rankLabel,
      stats,
      this.arenaLabel,
      el('div', 'spacer'),
      this.inviteButton,
      button('', t('menu.practice'), callbacks.onPractice),
      button('', t('menu.upgrades'), () => this.showPanel('upgrades')),
      button('', t('menu.records'), () => this.showPanel('records')),
    );

    // --- upgrades ---
    this.upgrades.hidden = true;
    this.upgrades.append(
      el('h1', '', t('menu.upgrades')),
      this.upgradeCash,
      this.upgradeList,
      el('div', 'spacer'),
      button('', t('menu.back'), () => this.showPanel('home')),
    );

    // --- records ---
    this.records.hidden = true;
    const tabs = el('div', 'tabs');
    this.friendsTab = button('', t('records.friends'), () => this.setRecordsMode('friends'));
    this.globalTab = button('', t('records.global'), () => this.setRecordsMode('global'));
    this.friendsTab.setAttribute('role', 'tab');
    this.globalTab.setAttribute('role', 'tab');
    tabs.setAttribute('role', 'tablist');
    tabs.append(this.friendsTab, this.globalTab);
    this.records.append(
      el('h1', '', t('menu.records')),
      tabs,
      this.recordList,
      el('div', 'spacer'),
      button('', t('menu.back'), () => this.showPanel('home')),
    );

    this.root.append(this.home, this.upgrades, this.records);
    this.setRecordsMode('friends');
  }

  private stat(label: string, valueNode: HTMLElement): HTMLElement {
    const wrap = el('div', 'stat');
    wrap.append(el('div', 'label', label), valueNode);
    return wrap;
  }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
    if (visible) this.showPanel('home');
  }

  /** Invites only exist inside the Usion host; hide the button when standalone. */
  setInviteAvailable(available: boolean): void {
    this.inviteButton.hidden = !available;
  }

  private showPanel(panel: 'home' | 'upgrades' | 'records'): void {
    show(this.home, panel === 'home');
    show(this.upgrades, panel === 'upgrades');
    show(this.records, panel === 'records');
    this.root.scrollTop = 0;
  }

  setProfile(profile: Profile): void {
    this.profile = profile;
    this.ratingValue.textContent = formatNumber(profile.rating);
    this.cashValue.textContent = formatNumber(profile.cash);
    this.recordValue.textContent = t('menu.record', {
      wins: profile.wins,
      losses: profile.losses,
    });
    this.rankLabel.textContent = t(rankTitleKey(profile.rating));

    const arenaIndex = highestUnlockedArena(profile.rating);
    const next = ARENAS[arenaIndex + 1];
    this.arenaLabel.textContent = next
      ? `${t(ARENAS[arenaIndex].nameKey)} · ${formatNumber(next.unlockRating - profile.rating)} → ${t(next.nameKey)}`
      : t(ARENAS[arenaIndex].nameKey);

    this.upgradeCash.textContent = `${t('menu.cash')}: ${formatNumber(profile.cash)}`;
    this.renderUpgrades(profile);
  }

  private renderUpgrades(profile: Profile): void {
    clear(this.upgradeList);

    for (const { track, labelKey } of TRACKS) {
      const level = profile.upgrades[track];
      const maxed = level >= MAX_UPGRADE_LEVEL;
      const cost = upgradeCost(level);
      const affordable = !maxed && profile.cash >= cost;

      const row = el('div', 'upgrade');
      const info = el('div', 'info');
      info.append(
        el('div', 'name', t(labelKey)),
        el(
          'div',
          'meta',
          maxed
            ? `${formatNumber(trackValue(track, level))} · ${t('upgrade.max')}`
            : `${formatNumber(trackValue(track, level))} → ${formatNumber(trackValue(track, level + 1))} · ${t('upgrade.level', { level })}`,
        ),
      );

      const pips = el('div', 'pips');
      for (let i = 0; i < MAX_UPGRADE_LEVEL; i += 1) {
        const pip = el('div', i < level ? 'pip on' : 'pip');
        pips.append(pip);
      }
      info.append(pips);

      const buy = button(
        affordable ? 'primary' : '',
        maxed ? t('upgrade.max') : t('upgrade.buy', { cost: formatNumber(cost) }),
        () => this.callbacks.onBuy(track),
      );
      buy.disabled = maxed || !affordable;
      if (!maxed && !affordable) buy.title = t('upgrade.locked');

      row.append(info, buy);
      this.upgradeList.append(row);
    }
  }

  onRecordsModeChange(handler: (mode: 'friends' | 'global') => void): void {
    this.onRecordsMode = handler;
  }

  private setRecordsMode(mode: 'friends' | 'global'): void {
    this.recordsMode = mode;
    this.friendsTab.setAttribute('aria-selected', String(mode === 'friends'));
    this.globalTab.setAttribute('aria-selected', String(mode === 'global'));
    this.onRecordsMode?.(mode);
  }

  get activeRecordsMode(): 'friends' | 'global' {
    return this.recordsMode;
  }

  setRecords(entries: LeaderboardEntry[]): void {
    clear(this.recordList);
    if (entries.length === 0) {
      this.recordList.append(el('div', 'empty', t('records.empty')));
      return;
    }
    for (const entry of entries) {
      const row = el('div', entry.is_me ? 'record me' : 'record');
      row.append(
        el('div', 'rank', `${entry.rank}`),
        el('div', 'who', entry.is_me ? t('records.you') : entry.name || '—'),
        el('div', 'score', formatNumber(entry.score)),
      );
      this.recordList.append(row);
    }
  }

  get currentProfile(): Profile | null {
    return this.profile;
  }
}
