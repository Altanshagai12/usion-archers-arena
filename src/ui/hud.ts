/**
 * The in-match overlay: whose turn it is, wind, the power bar while drawing,
 * hit feedback, the reconnect veil and the end-of-match result card.
 *
 * It owns no game state — `main.ts` pushes everything in.
 */

import { t, formatNumber } from '../i18n';
import { button, el, show } from './dom';
import type { HitZone } from '../sim';

export interface ResultActions {
  onAgain(): void;
  onExit(): void;
}

export class Hud {
  readonly root = el('div', 'hud');

  private readonly arenaChip = el('div', 'chip');
  private readonly windChip = el('div', 'chip');
  private readonly banner = el('div', 'turn-banner');
  private readonly hint = el('div', 'hint');
  private readonly power = el('div', 'power');
  private readonly powerFill = el('div');
  private readonly toast = el('div', 'toast');

  private readonly connectionVeil = el('div', 'veil');
  private readonly resultVeil = el('div', 'veil');
  private readonly resultTitle = el('h1');
  private readonly resultReward = el('div', 'reward');
  private readonly resultActions = el('div', 'actions');

  private toastTimer = 0;

  constructor(actions: ResultActions) {
    this.root.id = 'hud';
    this.root.hidden = true;

    const top = el('div', 'hud-top');
    top.append(this.arenaChip, this.windChip);

    const bottom = el('div', 'hud-bottom');
    this.power.hidden = true;
    this.power.append(this.powerFill);
    bottom.append(this.banner, this.power, this.hint);

    // Live regions: turn changes and hit results must reach screen readers.
    this.banner.setAttribute('role', 'status');
    this.banner.setAttribute('aria-live', 'polite');
    this.toast.setAttribute('role', 'status');
    this.toast.setAttribute('aria-live', 'assertive');

    this.power.setAttribute('role', 'progressbar');
    this.power.setAttribute('aria-valuemin', '0');
    this.power.setAttribute('aria-valuemax', '100');

    this.connectionVeil.hidden = true;
    this.connectionVeil.append(el('div', 'spinner'), el('div', '', t('hud.reconnecting')));

    this.resultVeil.hidden = true;
    this.resultActions.append(
      button('primary', t('result.again'), actions.onAgain),
      button('', t('result.exit'), actions.onExit),
    );
    this.resultVeil.append(this.resultTitle, this.resultReward, this.resultActions);

    this.root.append(top, this.toast, bottom, this.connectionVeil, this.resultVeil);
  }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
  }

  setArena(nameKey: string, wind: number): void {
    this.arenaChip.textContent = t(nameKey);

    const strength = Math.abs(wind);
    if (strength < 0.05) {
      this.windChip.textContent = `${t('hud.wind')} · ${t('hud.windCalm')}`;
      return;
    }
    // Arrow points the way the wind pushes; the number is its strength.
    const direction = wind > 0 ? '→' : '←';
    this.windChip.textContent = `${t('hud.wind')} ${direction} ${strength.toFixed(1)}`;
  }

  setTurn(mine: boolean, waiting: boolean): void {
    if (waiting) {
      this.banner.textContent = t('hud.waiting');
      this.banner.classList.remove('mine');
      this.hint.textContent = '';
      return;
    }
    this.banner.textContent = mine ? t('hud.yourTurn') : t('hud.opponentTurn');
    this.banner.classList.toggle('mine', mine);
    this.hint.textContent = mine ? t('hud.aimHint') : '';
  }

  setPower(value: number | null): void {
    if (value === null) {
      this.power.hidden = true;
      return;
    }
    const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
    this.power.hidden = false;
    this.powerFill.style.width = `${pct}%`;
    this.power.setAttribute('aria-valuenow', String(pct));
    this.power.setAttribute('aria-label', t('hud.power'));
  }

  showShotResult(zone: HitZone | null, damage: number, blocked: boolean): void {
    let text: string;
    let modifier = '';
    if (zone === 'head') {
      text = t('shot.headshot', { damage });
      modifier = 'head';
    } else if (zone === 'body') {
      text = t('shot.body', { damage });
    } else if (zone === 'limb') {
      text = t('shot.limb', { damage });
    } else {
      text = blocked ? t('shot.blocked') : t('shot.miss');
      modifier = 'miss';
    }

    this.toast.className = `toast show ${modifier}`.trim();
    this.toast.textContent = text;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toast.className = 'toast';
    }, 1150);
  }

  setReconnecting(active: boolean): void {
    show(this.connectionVeil, active);
  }

  showResult(won: boolean, forfeit: boolean, cash: number, ratingDelta: number): void {
    this.resultTitle.textContent = forfeit
      ? t('result.forfeit')
      : won
        ? t('result.win')
        : t('result.loss');
    const sign = ratingDelta >= 0 ? '+' : '';
    this.resultReward.textContent = t('result.reward', {
      cash: formatNumber(cash),
      rating: `${sign}${formatNumber(ratingDelta)}`,
    });
    show(this.resultVeil, true);
  }

  hideResult(): void {
    show(this.resultVeil, false);
  }

  /** Rematch is only meaningful against a bot or a peer who is still present. */
  setRematchEnabled(enabled: boolean): void {
    const first = this.resultActions.firstElementChild as HTMLButtonElement | null;
    if (first) first.disabled = !enabled;
  }
}
