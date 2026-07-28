/**
 * Разбор фразы во время срабатывания.
 *
 * Календарь из кнопок в Telegram неудобен всегда, поэтому произвольное
 * время вводится словами: «через 40 минут», «завтра в 9», «05.08 в 18:30».
 *
 * Всё считается в UTC, а понимается в местном времени пользователя:
 * «завтра в 9» — это девять утра у него, а не у сервера.
 */

export type ScheduleRule =
  | { kind: 'once' }
  | { kind: 'every'; minutes: number }
  /**
   * Дни недели со временем. Смещение пояса хранится прямо в правиле:
   * следующее срабатывание считает крон, у которого нет ни пользователя,
   * ни его настроек — только само правило.
   */
  | { kind: 'weekly'; days: number[]; hour: number; minute: number; offset: number };

export interface Schedule {
  at: number;
  rule: ScheduleRule;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Единицы во всех формах, которые реально произносят. */
const UNITS: Array<{ test: RegExp; ms: number }> = [
  { test: /^мин/i, ms: MINUTE },
  { test: /^час|^ч$/i, ms: HOUR },
  { test: /^дн|^день|^дня|^дней|^сут/i, ms: DAY },
  { test: /^недел/i, ms: 7 * DAY },
  { test: /^мес/i, ms: 30 * DAY },
  { test: /^год|^лет/i, ms: 365 * DAY },
];

function unitMs(word: string): number | null {
  return UNITS.find((unit) => unit.test.test(word))?.ms ?? null;
}

/** Местное время пользователя как «сдвинутый UTC» — удобно для арифметики. */
function toLocal(utcMs: number, offsetMin: number): Date {
  return new Date(utcMs + offsetMin * MINUTE);
}

function fromLocal(local: Date, offsetMin: number): number {
  return local.getTime() - offsetMin * MINUTE;
}

/** Ближайшее наступление указанного местного времени: сегодня либо завтра. */
function atLocalTime(nowMs: number, offsetMin: number, hours: number, minutes: number, dayShift = 0): number {
  const local = toLocal(nowMs, offsetMin);
  local.setUTCHours(hours, minutes, 0, 0);
  local.setUTCDate(local.getUTCDate() + dayShift);

  const at = fromLocal(local, offsetMin);
  // «в 9», когда уже десять — значит завтра в девять.
  return at > nowMs || dayShift !== 0 ? at : at + DAY;
}

// Граница слова через \b здесь не работает: для JS «слово» — это латиница,
// и перед кириллическим «в» границы нет. Проверяем начало строки или пробел.
const TIME = /(?:^|\s)в\s+(\d{1,2})(?:[:.](\d{2}))?/i;

function timeFrom(text: string, fallbackHour: number): { hours: number; minutes: number } {
  const match = TIME.exec(text);
  if (!match) return { hours: fallbackHour, minutes: 0 };

  const hours = Math.min(23, Number(match[1]));
  const minutes = match[2] ? Math.min(59, Number(match[2])) : 0;
  return { hours, minutes };
}

/**
 * Возвращает расписание или null, если фразу не поняли.
 *
 * null — не ошибка: вызывающий покажет примеры и попросит иначе.
 * Молча угадать не тот час хуже, чем переспросить.
 */
export function parseSchedule(text: string, nowMs: number, offsetMin: number): Schedule | null {
  const input = text.trim().toLowerCase();

  // «каждый понедельник и среду в 10:00», «по вторникам и пятницам».
  const days = weekdaysIn(input);
  if (days.length > 0 && /^(кажд|по)\p{L}*/u.test(input)) {
    const { hours, minutes } = timeFrom(input, 9);
    const rule: ScheduleRule = { kind: 'weekly', days, hour: hours, minute: minutes, offset: offsetMin };
    const at = nextRun(rule, nowMs);
    if (at) return { at, rule };
  }

  // «каждые 3 часа» — повтор с равным шагом.
  const every = /^кажд\p{L}*\s+(\d+)\s*(\S+)/u.exec(input);
  if (every) {
    const step = unitMs(every[2]!);
    const count = Number(every[1]);
    if (step && count > 0) {
      const minutes = Math.round((step * count) / MINUTE);
      return { at: nowMs + step * count, rule: { kind: 'every', minutes } };
    }
  }

  // «каждый день», «каждый час» — без числа.
  const everyOne = /^кажд\p{L}*\s+(\S+)/u.exec(input);
  if (everyOne) {
    const step = unitMs(everyOne[1]!);
    if (step) return { at: nowMs + step, rule: { kind: 'every', minutes: Math.round(step / MINUTE) } };
  }

  // «через 40 минут», «через 2 дня»
  const after = /^через\s+(\d+)?\s*(\S+)/.exec(input);
  if (after) {
    const step = unitMs(after[2]!);
    const count = after[1] ? Number(after[1]) : 1;
    if (step && count > 0) return { at: nowMs + step * count, rule: { kind: 'once' } };
  }

  if (/^завтра/.test(input)) {
    const { hours, minutes } = timeFrom(input, 9);
    return { at: atLocalTime(nowMs, offsetMin, hours, minutes, 1), rule: { kind: 'once' } };
  }

  if (/^послезавтра/.test(input)) {
    const { hours, minutes } = timeFrom(input, 9);
    return { at: atLocalTime(nowMs, offsetMin, hours, minutes, 2), rule: { kind: 'once' } };
  }

  if (/вечер/.test(input)) {
    return { at: atLocalTime(nowMs, offsetMin, 19, 0), rule: { kind: 'once' } };
  }

  if (/утр/.test(input)) {
    return { at: atLocalTime(nowMs, offsetMin, 9, 0), rule: { kind: 'once' } };
  }

  // «05.08 в 18:30», «5.8.2026»
  const date = /^(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{2,4}))?/.exec(input);
  if (date) {
    const { hours, minutes } = timeFrom(input, 9);
    const local = toLocal(nowMs, offsetMin);
    const year = date[3] ? Number(date[3].length === 2 ? `20${date[3]}` : date[3]) : local.getUTCFullYear();

    local.setUTCFullYear(year, Number(date[2]) - 1, Number(date[1]));
    local.setUTCHours(hours, minutes, 0, 0);

    let at = fromLocal(local, offsetMin);
    // Дата без года и уже прошла — значит имелся в виду следующий год.
    if (at <= nowMs && !date[3]) {
      local.setUTCFullYear(year + 1);
      at = fromLocal(local, offsetMin);
    }

    return at > nowMs ? { at, rule: { kind: 'once' } } : null;
  }

  // «в 18:30» без даты — ближайшее наступление.
  if (TIME.test(input)) {
    const { hours, minutes } = timeFrom(input, 9);
    return { at: atLocalTime(nowMs, offsetMin, hours, minutes), rule: { kind: 'once' } };
  }

  return null;
}

/** Названия дней во всех падежах, которые реально пишут. */
const WEEKDAYS: Array<{ test: RegExp; day: number }> = [
  { test: /воскресен|вс/i, day: 0 },
  { test: /понедельник|пн/i, day: 1 },
  { test: /вторник|вт/i, day: 2 },
  { test: /сред[ауые]|ср/i, day: 3 },
  { test: /четверг|чт/i, day: 4 },
  { test: /пятниц|пт/i, day: 5 },
  { test: /суббот|сб/i, day: 6 },
];

function weekdaysIn(text: string): number[] {
  const days = WEEKDAYS.filter((entry) => entry.test.test(text)).map((entry) => entry.day);
  return [...new Set(days)].sort((a, b) => a - b);
}

/**
 * Следующее срабатывание повторяющегося правила.
 *
 * Считается от текущего момента, а не от просроченного времени: иначе
 * после простоя крона напоминание выстрелит подряд столько раз, сколько
 * пропустило.
 */
export function nextRun(rule: ScheduleRule, fromMs: number): number | null {
  if (rule.kind === 'once') return null;
  if (rule.kind === 'every') return fromMs + rule.minutes * MINUTE;

  const local = toLocal(fromMs, rule.offset);

  for (let shift = 0; shift <= 7; shift += 1) {
    const candidate = new Date(local.getTime());
    candidate.setUTCDate(candidate.getUTCDate() + shift);
    candidate.setUTCHours(rule.hour, rule.minute, 0, 0);

    const at = fromLocal(candidate, rule.offset);
    if (rule.days.includes(candidate.getUTCDay()) && at > fromMs) return at;
  }

  return null;
}

/** Требует ли фраза знания часового пояса. */
export function needsTimezone(text: string): boolean {
  const input = text.trim().toLowerCase();
  // «через N» считается от текущего момента и в поясе не нуждается.
  return !/^через\s/.test(input) && !/^кажд\p{L}*\s+\d*\s*(мин|час)/u.test(input);
}

/** Человеческое описание расписания для списка и предпросмотра. */
export function describeSchedule(nextAt: string, rule: ScheduleRule, offsetMin: number): string {
  const local = toLocal(Date.parse(nextAt), offsetMin);
  const dd = String(local.getUTCDate()).padStart(2, '0');
  const mm = String(local.getUTCMonth() + 1).padStart(2, '0');
  const hh = String(local.getUTCHours()).padStart(2, '0');
  const mi = String(local.getUTCMinutes()).padStart(2, '0');

  const when = `${dd}.${mm} в ${hh}:${mi}`;
  if (rule.kind === 'once') return when;

  if (rule.kind === 'weekly') {
    const names = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
    const list = rule.days.map((day) => names[day]).join(', ');
    const hh = String(rule.hour).padStart(2, '0');
    const mi = String(rule.minute).padStart(2, '0');
    return `${list} в ${hh}:${mi} · ближайшее ${when}`;
  }

  const minutes = rule.minutes;
  const step =
    minutes % (24 * 60) === 0
      ? `${minutes / (24 * 60)} дн.`
      : minutes % 60 === 0
        ? `${minutes / 60} ч.`
        : `${minutes} мин.`;

  return `каждые ${step} · ближайшее ${when}`;
}
