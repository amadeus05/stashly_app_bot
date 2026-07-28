import type { ParsedQuery } from '../../domain/query.js';
import { toMatchExpression } from '../../domain/query.js';
import type { ObjectType, SearchHit } from '../../domain/types.js';

/**
 * Пересборка одной строки индекса.
 *
 * content склеивается из title, body, ключей и значений свойств, имён тегов
 * и caption вложения. Всё в одном документе — поэтому "AniStar" находится,
 * хотя лежит в свойстве, а не в названии.
 */
/**
 * Значение свойства в том виде, в каком его ищет пользователь.
 *
 * В индекс нельзя класть сырые колонки: тайминг хранится как 754 секунды,
 * дата — как ISO. Человек же ищет "12:34" и "01.07.2026", и без обратного
 * форматирования не нашёл бы ничего.
 */
const PROPERTY_TEXT = `
  CASE p.type
    WHEN 'bool' THEN CASE WHEN p.value_num <> 0 THEN 'да' ELSE 'нет' END
    WHEN 'duration' THEN
      CASE WHEN p.value_num >= 3600
        THEN printf('%d:%02d:%02d', CAST(p.value_num / 3600 AS INTEGER),
                    CAST(p.value_num AS INTEGER) % 3600 / 60, CAST(p.value_num AS INTEGER) % 60)
        ELSE printf('%d:%02d', CAST(p.value_num / 60 AS INTEGER), CAST(p.value_num AS INTEGER) % 60)
      END
    WHEN 'date' THEN
      -- Обе формы: и как человек вводил, и ISO — чтобы находилось любой.
      substr(p.value_date, 9, 2) || '.' || substr(p.value_date, 6, 2) || '.' ||
      substr(p.value_date, 1, 4) || ' ' || p.value_date
    WHEN 'number' THEN
      CASE WHEN p.value_num = CAST(p.value_num AS INTEGER)
        THEN CAST(CAST(p.value_num AS INTEGER) AS TEXT)
        ELSE CAST(p.value_num AS TEXT) END
    ELSE COALESCE(p.value_text, '')
  END`;

const REINDEX_SQL = `
INSERT INTO search_index(content, object_id, user_id, object_type)
SELECT
  TRIM(
    COALESCE(o.title, '') || ' ' || COALESCE(o.body, '') || ' ' ||
    COALESCE((SELECT group_concat(p.key || ' ' || ${PROPERTY_TEXT}, ' ')
      FROM properties p WHERE p.object_id = o.id), '') || ' ' ||
    COALESCE((SELECT group_concat(t.name, ' ') FROM object_tags ot
      JOIN tags t ON t.id = ot.tag_id WHERE ot.object_id = o.id), '') || ' ' ||
    COALESCE((SELECT a.caption FROM attachments a WHERE a.object_id = o.id), '') || ' ' ||
    -- Расшифровка голосового: без неё голосовые заметки не искались вовсе.
    COALESCE((SELECT a.transcript FROM attachments a WHERE a.object_id = o.id), '')
  ),
  o.id, o.user_id, o.type
FROM objects o WHERE o.id = ?1`;

/**
 * Поднимает найденный объект до корневой записи.
 * Глубина фиксирована (entry -> attachment -> note), поэтому двух JOIN'ов
 * достаточно и рекурсивный CTE не нужен.
 */
const ROOT_EXPR = `COALESCE(p2.id, p1.id, o.id)`;

/** Свойство может висеть на записи или на любом её потомке. */
const DESCENDANT_OF = (root: string) => `(
  d.id = ${root}
  OR d.parent_id = ${root}
  OR d.parent_id IN (SELECT id FROM objects WHERE parent_id = ${root})
)`;

export class SearchRepository {
  constructor(private readonly db: D1Database) {}

  /**
   * Разгребает очередь search_dirty.
   *
   * Триггеры только помечают объекты; собственно склейка происходит здесь.
   * Вызывается после каждой мутации и, на случай упавшего воркера, по крону.
   */
  async flushDirty(limit = 200): Promise<number> {
    const { results } = await this.db
      .prepare(`SELECT object_id FROM search_dirty ORDER BY queued_at LIMIT ?1`)
      .bind(limit)
      .all<{ object_id: string }>();

    if (results.length === 0) return 0;

    const statements: D1PreparedStatement[] = [];
    for (const { object_id: id } of results) {
      statements.push(this.db.prepare(`DELETE FROM search_index WHERE object_id = ?1`).bind(id));
      statements.push(this.db.prepare(REINDEX_SQL).bind(id));
      statements.push(this.db.prepare(`DELETE FROM search_dirty WHERE object_id = ?1`).bind(id));
    }

    await this.db.batch(statements);
    return results.length;
  }

  async search(userId: number, query: ParsedQuery, limit: number, offset: number): Promise<SearchHit[]> {
    const match = toMatchExpression(query.text);
    const binds: unknown[] = [];
    let n = 0;
    const next = (value: unknown): string => {
      binds.push(value);
      return `?${++n}`;
    };

    // Полнотекстовая часть. Без текста поиск вырождается в чистую
    // фильтрацию — это законный сценарий: "покажи всё с rating>=9".
    const userParam = next(userId);
    // bm25() и snippet() работают только там, где запрос обращается к
    // FTS-таблице напрямую. Простого подзапроса недостаточно: планировщик
    // схлопывает его во внешний JOIN, и SQLite отвечает
    // "unable to use function bm25 in the requested context".
    // AS MATERIALIZED запрещает схлопывание и сохраняет контекст.
    const ftsCte = match
      ? `fts AS MATERIALIZED (
           SELECT object_id,
                  snippet(search_index, 0, '', '', '…', 10) AS snip,
                  bm25(search_index) AS rank
           FROM search_index
           WHERE user_id = ${userParam} AND search_index MATCH ${next(match)}
         ), `
      : '';

    const matchCte = match
      ? `SELECT ${ROOT_EXPR} AS root_id, o.id AS matched_id, o.type AS matched_type,
                si.snip AS snip, si.rank AS rank
         FROM fts si
         JOIN objects o ON o.id = si.object_id
         LEFT JOIN objects p1 ON p1.id = o.parent_id
         LEFT JOIN objects p2 ON p2.id = p1.parent_id`
      : `SELECT o.id AS root_id, o.id AS matched_id, o.type AS matched_type,
                '' AS snip, 0 AS rank
         FROM objects o
         WHERE o.user_id = ${userParam} AND o.type = 'entry'`;

    const conditions: string[] = [];

    for (const tag of query.tags) {
      conditions.push(`EXISTS (
        SELECT 1 FROM object_tags ot JOIN tags t ON t.id = ot.tag_id
        WHERE ot.object_id = m.root_id AND t.name_norm = ${next(tag)})`);
    }

    for (const collection of query.collections) {
      conditions.push(`EXISTS (
        SELECT 1 FROM object_collections oc JOIN collections c ON c.id = oc.collection_id
        WHERE oc.object_id = m.root_id AND c.name_norm = ${next(collection)})`);
    }

    for (const filter of query.properties) {
      const key = next(filter.key);
      if (filter.op === '=') {
        // Текстовое равенство — регистронезависимое: voice:anistar должен
        // находить "AniStar", иначе фильтром никто не воспользуется.
        conditions.push(`EXISTS (
          SELECT 1 FROM properties p JOIN objects d ON d.id = p.object_id
          WHERE ${DESCENDANT_OF('m.root_id')} AND p.key_norm = ${key}
            AND (LOWER(COALESCE(p.value_text, '')) = ${next((filter.text ?? '').toLowerCase())}
                 OR CAST(p.value_num AS TEXT) = ${next(filter.text ?? '')}))`);
      } else {
        conditions.push(`EXISTS (
          SELECT 1 FROM properties p JOIN objects d ON d.id = p.object_id
          WHERE ${DESCENDANT_OF('m.root_id')} AND p.key_norm = ${key}
            AND p.value_num IS NOT NULL AND p.value_num ${filter.op} ${next(filter.num ?? 0)})`);
      }
    }

    for (const has of query.has) {
      if (has === 'note') {
        conditions.push(`EXISTS (
          SELECT 1 FROM objects d WHERE d.parent_id = m.root_id AND d.type = 'note')`);
        continue;
      }
      const mediaTypes =
        has === 'image' ? ['photo', 'animation'] : has === 'video' ? ['video', 'video_note'] : [has];
      const placeholders = mediaTypes.map((type) => next(type)).join(', ');
      conditions.push(`EXISTS (
        SELECT 1 FROM objects d JOIN attachments a ON a.object_id = d.id
        WHERE d.parent_id = m.root_id AND a.media_type IN (${placeholders}))`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // MIN(rank) + GROUP BY: SQLite отдаёт остальные колонки из той же строки,
    // то есть на запись остаётся одно, самое релевантное попадание.
    const sql = `
      WITH ${ftsCte}matches AS (${matchCte})
      SELECT m.root_id, e.title AS entry_title, m.matched_id, m.matched_type, m.snip,
             MIN(m.rank) AS best
      FROM matches m
      JOIN objects e ON e.id = m.root_id AND e.type = 'entry'
      ${where}
      GROUP BY m.root_id
      ORDER BY best, e.updated_at DESC
      LIMIT ${next(limit)} OFFSET ${next(offset)}`;

    const { results } = await this.db
      .prepare(sql)
      .bind(...binds)
      .all<{
        root_id: string;
        entry_title: string | null;
        matched_id: string;
        matched_type: ObjectType;
        snip: string;
      }>();

    return results.map((row) => ({
      entryId: row.root_id,
      entryTitle: row.entry_title ?? 'Без названия',
      matchedObjectId: row.matched_id,
      matchedType: row.matched_type,
      snippet: row.snip ?? '',
    }));
  }
}
