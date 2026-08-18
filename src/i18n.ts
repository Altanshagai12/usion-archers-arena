/**
 * Locale strings. The host tells us the user's language via
 * `Usion.getLanguage()`; anything we don't ship falls back to English.
 * Never inline user-facing text anywhere else in the game.
 */

type Dict = Record<string, string>;

const en: Dict = {
  'app.title': 'Archers Arena',
  'app.loading': 'Loading arena…',
  'app.unsupported': 'This device cannot run 3D graphics.',
  'app.unsupportedHint': 'WebGL is unavailable. Try another browser or device.',

  'arena.greenwood': 'Greenwood',
  'arena.ruins': 'Sunken Ruins',
  'arena.rampart': 'The Rampart',
  'arena.cliffs': 'Windward Cliffs',
  'arena.citadel': 'Night Citadel',

  'rank.novice': 'Novice',
  'rank.archer': 'Archer',
  'rank.veteran': 'Veteran',
  'rank.master': 'Master',
  'rank.legend': 'Legend',

  'menu.play': 'Play',
  'menu.practice': 'Play vs bot',
  'menu.invite': 'Invite a friend',
  'menu.upgrades': 'Upgrades',
  'menu.records': 'Records',
  'menu.back': 'Back',
  'menu.rating': 'Rating',
  'menu.cash': 'Gold',
  'menu.record': '{wins}W · {losses}L',
  'menu.recordLabel': 'Won / lost',

  'upgrade.health': 'Max health',
  'upgrade.damage': 'Base damage',
  'upgrade.headshot': 'Headshot damage',
  'upgrade.buy': 'Upgrade · {cost}',
  'upgrade.max': 'Maxed',
  'upgrade.level': 'Lv {level}',
  'upgrade.locked': 'Not enough gold',

  'hud.yourTurn': 'Your turn',
  'hud.opponentTurn': "Opponent's turn",
  'hud.aimHint': 'Drag to aim, release to shoot',
  'hud.power': 'Power',
  'hud.wind': 'Wind',
  'hud.windCalm': 'Calm',
  'hud.windHead': 'against',
  'hud.windTail': 'with',
  'hud.you': 'You',
  'hud.opponent': 'Rival',
  'hud.waiting': 'Waiting for opponent…',
  'hud.reconnecting': 'Reconnecting…',

  'shot.headshot': 'Headshot! −{damage}',
  'shot.body': 'Hit −{damage}',
  'shot.limb': 'Graze −{damage}',
  'shot.miss': 'Miss',
  'shot.blocked': 'Blocked',

  'result.win': 'Victory',
  'result.loss': 'Defeat',
  'result.forfeit': 'Opponent left — you win',
  'result.reward': '+{cash} gold · {rating} rating',
  'result.again': 'Play again',
  'result.exit': 'Leave',

  'records.title': 'Friends',
  'records.empty': 'No records yet. Win a match to appear here.',
  'records.you': 'You',
  'records.global': 'Global',
  'records.friends': 'Friends',
};

const mn: Dict = {
  'app.title': 'Харваачдын Талбар',
  'app.loading': 'Талбар ачаалж байна…',
  'app.unsupported': 'Энэ төхөөрөмж 3D дүрс дэмжихгүй байна.',
  'app.unsupportedHint': 'WebGL боломжгүй байна. Өөр хөтөч эсвэл төхөөрөмж ашиглана уу.',

  'arena.greenwood': 'Ногоон ой',
  'arena.ruins': 'Балгас',
  'arena.rampart': 'Хэрмийн хана',
  'arena.cliffs': 'Салхит хад',
  'arena.citadel': 'Шөнийн цайз',

  'rank.novice': 'Шинэхэн',
  'rank.archer': 'Харваач',
  'rank.veteran': 'Туршлагатан',
  'rank.master': 'Мастер',
  'rank.legend': 'Домог',

  'menu.play': 'Тоглох',
  'menu.practice': 'Ботьтой тоглох',
  'menu.invite': 'Найзаа урих',
  'menu.upgrades': 'Сайжруулалт',
  'menu.records': 'Амжилт',
  'menu.back': 'Буцах',
  'menu.rating': 'Оноо',
  'menu.cash': 'Алт',
  'menu.record': '{wins}Я · {losses}Х',
  'menu.recordLabel': 'Ялалт / хожигдол',

  'upgrade.health': 'Их эрүүл мэнд',
  'upgrade.damage': 'Суурь хохирол',
  'upgrade.headshot': 'Толгойн хохирол',
  'upgrade.buy': 'Сайжруулах · {cost}',
  'upgrade.max': 'Дээд түвшин',
  'upgrade.level': '{level}-р түвшин',
  'upgrade.locked': 'Алт хүрэлцэхгүй',

  'hud.yourTurn': 'Таны ээлж',
  'hud.opponentTurn': 'Өрсөлдөгчийн ээлж',
  'hud.aimHint': 'Чирж онилоод, тавьж харва',
  'hud.power': 'Хүч',
  'hud.wind': 'Салхи',
  'hud.windCalm': 'Тайван',
  'hud.windHead': 'сөрөг',
  'hud.windTail': 'дагуу',
  'hud.you': 'Та',
  'hud.opponent': 'Өрсөлдөгч',
  'hud.waiting': 'Өрсөлдөгчийг хүлээж байна…',
  'hud.reconnecting': 'Дахин холбогдож байна…',

  'shot.headshot': 'Толгойд оноолоо! −{damage}',
  'shot.body': 'Оноолоо −{damage}',
  'shot.limb': 'Хажуугаар −{damage}',
  'shot.miss': 'Оногүй',
  'shot.blocked': 'Хаагдлаа',

  'result.win': 'Ялалт',
  'result.loss': 'Ялагдал',
  'result.forfeit': 'Өрсөлдөгч гарлаа — та яллаа',
  'result.reward': '+{cash} алт · {rating} оноо',
  'result.again': 'Дахин тоглох',
  'result.exit': 'Гарах',

  'records.title': 'Найзууд',
  'records.empty': 'Одоогоор амжилт алга. Ялж энд гарч ирээрэй.',
  'records.you': 'Та',
  'records.global': 'Дэлхий',
  'records.friends': 'Найзууд',
};

const DICTS: Record<string, Dict> = { en, mn };

let active: Dict = en;

export function setLanguage(language: string | undefined): void {
  const code = (language ?? 'en').slice(0, 2).toLowerCase();
  active = DICTS[code] ?? en;
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const template = active[key] ?? en[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    name in vars ? String(vars[name]) : `{${name}}`,
  );
}

/** Locale-aware number formatting for gold, rating and damage. */
export function formatNumber(value: number, language?: string): string {
  try {
    return new Intl.NumberFormat(language || undefined).format(value);
  } catch {
    return String(value);
  }
}
