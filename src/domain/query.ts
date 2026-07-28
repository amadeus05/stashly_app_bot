/**
 * Разбор поисковой строки.
 *
 * Пользователь пишет одной строкой и свободный текст, и фильтры:
 *
 *   collection:донхуа rating>=9 tag:favorite has:image небеса
 *
 * Свободный текст уходит в FTS5, фильтры — в обычный SQL по properties /
 * object_tags / object_collections. Смешивать их в одном индексе нельзя:
 * FTS не умеет сравнивать числа.
 */

export type Comparison = '=' | '>' | '>=' | '<' | '<=';

export interface PropertyFilter {
  key: string;
  op: Comparison;
  /** Для '=' сравниваем текст, иначе число. */
  text?: string;
  num?: number;
}

export type MediaFilter = 'image' | 'video' | 'voice' | 'audio' | 'document' | 'note';

export interface ParsedQuery {
  /** Свободный текст для FTS5; пустая строка — фильтровать без полнотекста. */
  text: string;
  tags: string[];
  collections: string[];
  properties: PropertyFilter[];
  has: MediaFilter[];
}

const TOKEN = /(\S+?)(>=|<=|>|<|:|=)(\S+)/;

const MEDIA_ALIASES: Record<string, MediaFilter> = {
  image: 'image',
  photo: 'image',
  фото: 'image',
  картинка: 'image',
  video: 'video',
  видео: 'video',
  voice: 'voice',
  голосовое: 'voice',
  audio: 'audio',
  аудио: 'audio',
  document: 'document',
  документ: 'document',
  note: 'note',
  заметка: 'note',
};

const TAG_KEYS = new Set(['tag', 'тег', 'тэг']);
const COLLECTION_KEYS = new Set(['collection', 'раздел', 'коллекция']);
const HAS_KEYS = new Set(['has', 'есть']);

export function parseQuery(input: string): ParsedQuery {
  const result: ParsedQuery = { text: '', tags: [], collections: [], properties: [], has: [] };
  const freeText: string[] = [];

  // Пробелы вокруг знака убираем до разбора: «оценка >= 9» человек пишет
  // так же охотно, как «оценка>=9», а разбор идёт по пробелам и без этого
  // распался бы на три отдельных слова для текстового поиска.
  const normalized = input.trim().replace(/\s*(>=|<=|>|<|=|:)\s*/g, '$1');

  for (const token of normalized.split(/\s+/).filter(Boolean)) {
    const match = TOKEN.exec(token);
    if (!match) {
      freeText.push(token);
      continue;
    }

    const key = match[1]!.toLowerCase();
    const op = match[2]! as Comparison | ':';
    const value = match[3]!;

    // "12:34" — это тайминг, который пользователь ищет как текст, а не
    // фильтр «свойство 12 равно 34». Имя свойства обязано содержать букву.
    if (!/\p{L}/u.test(key)) {
      freeText.push(token);
      continue;
    }

    if (op === ':' && TAG_KEYS.has(key)) {
      result.tags.push(value.toLowerCase());
      continue;
    }

    if (op === ':' && COLLECTION_KEYS.has(key)) {
      result.collections.push(value.toLowerCase());
      continue;
    }

    if (op === ':' && HAS_KEYS.has(key)) {
      const media = MEDIA_ALIASES[value.toLowerCase()];
      if (media) result.has.push(media);
      // Неизвестное has: игнорируем молча — это опечатка, а не повод
      // отправлять "12:34" в фильтры и ломать поиск.
      continue;
    }

    const numeric = Number(value.replace(',', '.'));
    if (op !== ':' && op !== '=' && Number.isNaN(numeric)) {
      // rating>=абв — бессмыслица, считаем обычным текстом.
      freeText.push(token);
      continue;
    }

    if (op === ':' || op === '=') {
      result.properties.push({ key, op: '=', text: value });
    } else {
      result.properties.push({ key, op, num: numeric });
    }
  }

  result.text = freeText.join(' ');
  return result;
}

/**
 * Готовит строку для FTS5 MATCH.
 *
 * Пользовательский ввод нельзя отдавать в MATCH напрямую: кавычки, звёздочки
 * и слова AND/OR/NOT — это синтаксис FTS, и на нём запрос падает с ошибкой.
 * Каждый терм экранируем и берём в кавычки, соединяя через AND.
 *
 * К термам от двух символов добавляем `*` — поиск по началу слова.
 * Человек пишет «дон», ожидая найти «Донхуа», и это ожидание правильное.
 * Односимвольные термы оставляем точными: «а*» совпало бы почти со всем.
 */
export function toMatchExpression(text: string): string | null {
  const terms = text
    .split(/\s+/)
    .map((term) => term.replace(/["*^:()\-]/g, ' ').trim())
    .filter((term) => term.length > 0)
    .map((term) => (term.length >= 2 ? `"${term}"*` : `"${term}"`));

  return terms.length > 0 ? terms.join(' AND ') : null;
}

/**
 * Убирает ведущее командное слово из наговоренного.
 *
 * Поиск требует совпадения всех слов, а «найди» в записях не встречается —
 * с ним запрос всегда возвращал бы пусто.
 *
 * Границу слова нельзя проверять обычным способом: для JS «слово» — это латиница,
 * и после кириллического «найди» границы просто нет. Поэтому явная
 * проверка, что дальше не буква — иначе «Найденное сокровище» превратилось
 * бы в «ное сокровище».
 */
export function stripCommandPrefix(text: string): string {
  const stripped = text.replace(
    /^\s*(?:найди(?:те)?|найти|поищи|ищи|покажи|поиск|find|search)(?!\p{L})[\s,.:;—-]*/iu,
    '',
  );

  // Если от фразы ничего не осталось, ищем по исходной: «найди» одним
  // словом — это не пустой запрос, а просьба открыть поиск.
  return stripped.trim().length > 0 ? stripped : text;
}
