import { newId, norm } from '../../core/id.js';

export interface TagDef {
  id: string;
  name: string;
  collectionId: string | null;
  collectionName: string | null;
  /** На скольких объектах висит — чтобы удаление не было вслепую. */
  uses: number;
}

export type TagFilter = string | null;
export type TagSort = 'asc' | 'desc';

interface TagRow {
  id: string;
  name: string;
  collection_id: string | null;
  collection_name: string | null;
  uses: number;
}

const toTag = (row: TagRow): TagDef => ({
  id: row.id,
  name: row.name,
  collectionId: row.collection_id,
  collectionName: row.collection_name,
  uses: row.uses,
});

const SELECT_TAG = `
  SELECT t.id, t.name, t.collection_id, c.name AS collection_name,
         (SELECT COUNT(*) FROM object_tags ot WHERE ot.tag_id = t.id) AS uses
  FROM tags t
  LEFT JOIN collections c ON c.id = t.collection_id`;

/**
 * Управление тегами как справочником.
 *
 * Проставление тега на запись живёт в EntryRepository — это про данные
 * записи. Здесь только сами теги: завести, переименовать, удалить.
 */
export class TagRepository {
  constructor(private readonly db: D1Database) {}

  async list(userId: number, filter: TagFilter, sort: TagSort): Promise<TagDef[]> {
    const scope =
      filter === null ? '' : filter === 'global' ? 'AND t.collection_id IS NULL' : 'AND t.collection_id = ?2';

    const direction = sort === 'desc' ? 'DESC' : 'ASC';
    const statement = this.db.prepare(
      `${SELECT_TAG} WHERE t.user_id = ?1 ${scope} ORDER BY t.name COLLATE NOCASE ${direction}`,
    );

    const bound =
      filter !== null && filter !== 'global' ? statement.bind(userId, filter) : statement.bind(userId);

    const { results } = await bound.all<TagRow>();
    return results.map(toTag);
  }

  async find(userId: number, tagId: string): Promise<TagDef | null> {
    const row = await this.db
      .prepare(`${SELECT_TAG} WHERE t.user_id = ?1 AND t.id = ?2`)
      .bind(userId, tagId)
      .first<TagRow>();

    return row ? toTag(row) : null;
  }

  /** Заводит тег заранее, без привязки к записи. */
  async create(userId: number, name: string, collectionId: string | null): Promise<string> {
    const id = newId();
    await this.db
      .prepare(
        `INSERT INTO tags(id, user_id, name, name_norm, collection_id)
         VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT DO NOTHING`,
      )
      .bind(id, userId, name.trim(), norm(name), collectionId)
      .run();

    const existing = await this.db
      .prepare(`SELECT id FROM tags WHERE user_id = ?1 AND name_norm = ?2`)
      .bind(userId, norm(name))
      .first<{ id: string }>();

    return existing?.id ?? id;
  }

  /**
   * Переименование затрагивает все записи с этим тегом сразу — это и есть
   * смысл справочника. Имя уникально на пользователя, поэтому столкновение
   * с существующим тегом объясняем словами.
   */
  async rename(userId: number, tagId: string, name: string): Promise<string | null> {
    try {
      await this.db
        .prepare(`UPDATE tags SET name = ?3, name_norm = ?4 WHERE id = ?1 AND user_id = ?2`)
        .bind(tagId, userId, name.trim(), norm(name))
        .run();

      return null;
    } catch (error) {
      if (String(error).includes('UNIQUE')) {
        return 'Такой тег уже есть — объединять теги бот пока не умеет.';
      }
      throw error;
    }
  }

  async setScope(userId: number, tagId: string, collectionId: string | null): Promise<void> {
    await this.db
      .prepare(`UPDATE tags SET collection_id = ?3 WHERE id = ?1 AND user_id = ?2`)
      .bind(tagId, userId, collectionId)
      .run();
  }

  /** Удаляет тег насовсем — связи с записями уходят каскадом. */
  async delete(userId: number, tagId: string): Promise<void> {
    await this.db.prepare(`DELETE FROM tags WHERE id = ?1 AND user_id = ?2`).bind(tagId, userId).run();
  }

  async preferences(userId: number): Promise<{ sort: TagSort; filter: TagFilter }> {
    const row = await this.db
      .prepare(`SELECT tags_sort, tags_filter FROM users WHERE id = ?1`)
      .bind(userId)
      .first<{ tags_sort: TagSort; tags_filter: string | null }>();

    return { sort: row?.tags_sort ?? 'asc', filter: row?.tags_filter ?? null };
  }

  async setPreferences(userId: number, sort: TagSort, filter: TagFilter): Promise<void> {
    await this.db
      .prepare(`UPDATE users SET tags_sort = ?2, tags_filter = ?3 WHERE id = ?1`)
      .bind(userId, sort, filter)
      .run();
  }
}
