import type { Property, PropertyType } from './types.js';

/** Значение свойства, разложенное по типизированным колонкам. */
export interface TypedValue {
  type: PropertyType;
  valueText: string | null;
  valueNum: number | null;
  valueDate: string | null;
}

const DATE_ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/;
const DATE_RU = /^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})$/;
const NUMBER = /^-?\d+(?:[.,]\d+)?$/;
const DURATION = /^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$/;
const URL_RE = /^https?:\/\/\S+$/i;

const TRUE_WORDS = new Set(['да', 'yes', 'true', '+', 'ага']);
const FALSE_WORDS = new Set(['нет', 'no', 'false', '-']);

/**
 * Угадывает тип по тому, что ввёл пользователь.
 *
 * Пользователь пишет "9.8", "2026-07-01", "12:34" — и не должен выбирать
 * тип руками. Если угадали неверно, тип можно поменять явно: смысл в том,
 * чтобы не заставлять человека думать о типах в 95% случаев.
 */
export function inferValue(raw: string): TypedValue {
  const input = raw.trim();

  if (URL_RE.test(input)) {
    return { type: 'url', valueText: input, valueNum: null, valueDate: null };
  }

  // Раньше чисел: "12:34" — это тайминг, а не число.
  const duration = DURATION.exec(input);
  if (duration) {
    const h = Number(duration[1]);
    const m = Number(duration[2]);
    const s = duration[3] ? Number(duration[3]) : 0;
    // Без третьей группы "12:34" читается как мм:сс, а не чч:мм.
    const seconds = duration[3] ? h * 3600 + m * 60 + s : h * 60 + m;
    return { type: 'duration', valueText: null, valueNum: seconds, valueDate: null };
  }

  if (NUMBER.test(input)) {
    return { type: 'number', valueText: null, valueNum: Number(input.replace(',', '.')), valueDate: null };
  }

  if (DATE_ISO.test(input)) {
    const date = new Date(input.replace(' ', 'T'));
    if (!Number.isNaN(date.getTime())) {
      return { type: 'date', valueText: null, valueNum: null, valueDate: date.toISOString() };
    }
  }

  const ru = DATE_RU.exec(input);
  if (ru) {
    const iso = `${ru[3]}-${ru[2]!.padStart(2, '0')}-${ru[1]!.padStart(2, '0')}T00:00:00.000Z`;
    const date = new Date(iso);
    if (!Number.isNaN(date.getTime())) {
      return { type: 'date', valueText: null, valueNum: null, valueDate: date.toISOString() };
    }
  }

  const lower = input.toLowerCase();
  if (TRUE_WORDS.has(lower)) {
    return { type: 'bool', valueText: null, valueNum: 1, valueDate: null };
  }
  if (FALSE_WORDS.has(lower)) {
    return { type: 'bool', valueText: null, valueNum: 0, valueDate: null };
  }

  return { type: 'text', valueText: input, valueNum: null, valueDate: null };
}

/** Обратное преобразование — то, что видит пользователь в карточке. */
export function formatValue(property: Property): string {
  switch (property.type) {
    case 'bool':
      return property.valueNum ? 'да' : 'нет';

    case 'date': {
      if (!property.valueDate) return '';
      const date = new Date(property.valueDate);
      const dd = String(date.getUTCDate()).padStart(2, '0');
      const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
      return `${dd}.${mm}.${date.getUTCFullYear()}`;
    }

    case 'duration': {
      const total = property.valueNum ?? 0;
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      return h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        : `${m}:${String(s).padStart(2, '0')}`;
    }

    case 'number':
      return String(property.valueNum ?? '');

    default:
      return property.valueText ?? '';
  }
}

/** Текст свойства для полнотекстового индекса. */
export function indexableText(property: Property): string {
  return `${property.key} ${formatValue(property)}`;
}
