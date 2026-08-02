import type { Comparison, MediaFilter, ParsedQuery } from '../domain/query.js';

/**
 * Разбор сказанного в поисковый запрос.
 *
 * Модель не ходит в базу и не придумывает идентификаторы — она только
 * переводит фразу в ту же структуру, которую уже понимает поиск. Дальше
 * работает существующий код фильтров, ничего не зная про модель.
 */

/** Дешёвая и быстрая; для перевода фразы в структуру этого достаточно. */
const MODEL = 'llama-3.3-70b-versatile';
const TIMEOUT_MS = 15_000;

export interface IntentContext {
  collections: string[];
  tags: string[];
  keys: string[];
}

export interface ParsedIntent {
  intent: 'search' | 'unknown';
  query: ParsedQuery;
}

const OPS = new Set<Comparison>(['=', '>', '>=', '<', '<=']);
const MEDIA = new Set<MediaFilter>(['image', 'video', 'voice', 'audio', 'document', 'note']);

/**
 * Приводит ответ модели к нашей структуре.
 *
 * Отдельная чистая функция, потому что ломается именно здесь: модель
 * возвращает лишние поля, строку вместо числа, выдуманный оператор.
 * Всё, что не укладывается в схему, молча отбрасывается — лучше искать
 * по части условий, чем упасть.
 */
const norm = (text: string): string =>
  text.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Основа слова: отбрасываем окончание, чтобы «стихи» нашлись в «стихах».
 *
 * Коротким словам резать нечего — они и так почти основа, а обрубок
 * в три буквы начал бы совпадать со всем подряд.
 */
const stem = (word: string): string => {
  if (word.length >= 7) return word.slice(0, word.length - 2);
  if (word.length >= 5) return word.slice(0, word.length - 1);
  return word;
};

/**
 * Название должно прозвучать.
 *
 * Модель охотно угадывает по смыслу: «За гранью времени» похоже на стихи —
 * и она дописывает раздел:стихи, которого никто не называл. Проверить это
 * промптом нельзя, поэтому проверяем ответ: каждое слово названия обязано
 * найтись в сказанном. Не нашлось — фильтр отбрасываем, слова всё равно
 * останутся в полнотекстовой части.
 */
function spoken(name: string, said: string): boolean {
  const words = norm(name).split(' ').filter(Boolean);
  if (words.length === 0) return false;

  return words.every((word) => said.includes(stem(word)));
}

export function toParsedQuery(raw: unknown, said = ''): ParsedIntent {
  const source = (raw ?? {}) as Record<string, unknown>;
  const query: ParsedQuery = { text: '', tags: [], collections: [], properties: [], has: [] };

  if (typeof source.text === 'string') query.text = source.text.trim().slice(0, 200);

  const strings = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string').slice(0, 10).map((item) => item.toLowerCase())
      : [];

  // Пустое said — вызов без исходной фразы (разбор ответа в тестах):
  // проверять нечем, оставляем как есть.
  const heard = norm(said);
  const grounded = (items: string[]) => (heard ? items.filter((item) => spoken(item, heard)) : items);

  query.tags = grounded(strings(source.tags));
  query.collections = grounded(strings(source.collections));
  query.has = strings(source.has).filter((item): item is MediaFilter => MEDIA.has(item as MediaFilter));

  if (Array.isArray(source.properties)) {
    for (const item of source.properties.slice(0, 10)) {
      const entry = (item ?? {}) as Record<string, unknown>;
      const key = typeof entry.key === 'string' ? entry.key.trim().toLowerCase() : '';
      const op = (typeof entry.op === 'string' ? entry.op : '=') as Comparison;
      if (!key || !OPS.has(op)) continue;
      if (heard && !spoken(key, heard)) continue;

      if (op === '=') {
        const text = entry.value === undefined || entry.value === null ? '' : String(entry.value);
        if (text) query.properties.push({ key, op, text });
        continue;
      }

      // Сравнения работают только по числам: «оценка больше хорошо» —
      // не запрос, а недоразумение.
      const num = Number(String(entry.value).replace(',', '.'));
      if (Number.isFinite(num)) query.properties.push({ key, op, num });
    }
  }

  const empty =
    !query.text &&
    query.tags.length === 0 &&
    query.collections.length === 0 &&
    query.properties.length === 0 &&
    query.has.length === 0;

  const intent = source.intent === 'search' && !empty ? 'search' : 'unknown';
  return { intent, query };
}

/** Промпт собирается из того, что у пользователя реально есть. */
function buildPrompt(context: IntentContext): string {
  const list = (items: string[]) => (items.length > 0 ? items.slice(0, 40).join(', ') : '—');

  return [
    'Ты разбираешь произнесённую фразу в поисковый запрос по личной базе заметок.',
    'Отвечай ТОЛЬКО объектом JSON, без пояснений.',
    '',
    'Схема:',
    '{"intent":"search"|"unknown","text":string,"tags":string[],"collections":string[],',
    ' "properties":[{"key":string,"op":"="|">"|">="|"<"|"<=","value":string|number}],',
    ' "has":["image"|"video"|"voice"|"audio"|"document"|"note"]}',
    '',
    'Правила:',
    '- text — только слова для полнотекстового поиска, без служебных «найди», «покажи».',
    '- Раздел, тег или поле указывай ТОЛЬКО если его название прозвучало в фразе.',
    '- Не угадывай раздел по смыслу. «За гранью времени» — это text, а не раздел «Стихи».',
    '- Сомневаешься — оставь слова в text. Лишний фильтр хуже, чем его отсутствие.',
    '- «больше равно», «не меньше», «от N и выше» — это op ">=". «выше», «больше» — ">".',
    '- Числительные словами переводи в числа: «девять» -> 9.',
    '- Если фраза не про поиск или непонятна — intent "unknown".',
    '',
    `Разделы: ${list(context.collections)}`,
    `Теги: ${list(context.tags)}`,
    `Поля: ${list(context.keys)}`,
  ].join('\n');
}

/**
 * Возвращает разбор или null.
 *
 * null — сигнал вызывающему вернуться к обычному поиску по тексту.
 * Ни отказ модели, ни мусор в ответе не должны ломать сценарий.
 */
export async function parseIntent(
  groqToken: string | undefined,
  text: string,
  context: IntentContext,
): Promise<ParsedIntent | null> {
  if (!groqToken) return null;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${groqToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        // Гарантированный JSON на выходе: без этого пришлось бы
        // выковыривать объект из прозы.
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: 400,
        messages: [
          { role: 'system', content: buildPrompt(context) },
          { role: 'user', content: text },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      console.error('intent failed', response.status, await response.text());
      return null;
    }

    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) return null;

    return toParsedQuery(JSON.parse(content), text);
  } catch (error) {
    console.error('intent error', error);
    return null;
  }
}
