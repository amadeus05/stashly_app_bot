/**
 * Где именно совпал запрос.
 *
 * Поиск возвращает запись целиком, но человеку важно понять, почему она
 * нашлась: по названию, по полю или по слову в заметке. Сопоставление
 * делается здесь, а не в SQL, потому что LOWER() в SQLite не понимает
 * кириллицу — «Оценка» останется «Оценка», и сравнение без учёта
 * регистра просто не сработает.
 */

export type SiteKind = 'property' | 'note' | 'caption' | 'transcript';

export interface Candidate {
  kind: SiteKind;
  /** Название поля; у заметок и подписей пусто. */
  label: string;
  text: string;
}

export interface MatchSite extends Candidate {
  /** Совпало по слову запроса, а не притянуто фильтром. */
  matched: boolean;
}

/** Слова запроса, по которым ищем совпадение. Пустые и однобуквенные не в счёт. */
export function termsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,.;:!?()"'«»]+/)
    .filter((term) => term.length >= 2);
}

/**
 * Совпадение по началу слова — так же, как ищет FTS.
 *
 * «оцен» находит «Оценка», но не «переоценка»: поиск по началу слова, а
 * не по вхождению в середину. Иначе выдача наполнится случайностями.
 */
function hits(term: string, text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.startsWith(term)) return true;

  // Проверяем начало каждого слова.
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(term)}`, 'u').test(lower);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Отбирает места совпадения.
 *
 * `limit` не украшение: совпадений в одной записи бывает много, а у
 * сообщения Telegram жёсткий лимит длины — простыня из двадцати строк
 * просто не отправится.
 */
export function findSites(terms: string[], candidates: Candidate[], limit = 2): MatchSite[] {
  if (terms.length === 0) return [];

  const found: MatchSite[] = [];

  for (const candidate of candidates) {
    const haystack = `${candidate.label} ${candidate.text}`;
    if (terms.some((term) => hits(term, haystack))) {
      found.push({ ...candidate, matched: true });
    }
    if (found.length >= limit) break;
  }

  return found;
}
