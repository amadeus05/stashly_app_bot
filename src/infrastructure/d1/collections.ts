import { newId, norm } from '../../core/id.js';
import type { Collection } from '../../domain/types.js';

interface CollectionRow {
  id: string;
  user_id: number;
  name: string;
  icon: string | null;
}

const toCollection = (row: CollectionRow): Collection => ({
  id: row.id,
  userId: row.user_id,
  name: row.name,
  icon: row.icon,
});

export class CollectionRepository {
  constructor(private readonly db: D1Database) {}

  /**
   * Длина имени ограничена не «на всякий случай»: пользователь легко
   * вставляет в мастер скопированную подсказку или целый абзац, и такой
   * раздел потом не помещается ни в кнопку, ни в список.
   */
  static readonly MAX_NAME = 64;

  async create(userId: number, name: string, icon: string | null): Promise<Collection> {
    const id = newId();
    await this.db
      .prepare(
        `INSERT INTO collections(id, user_id, name, name_norm, icon, position)
         VALUES (?1, ?2, ?3, ?4, ?5,
                 (SELECT COALESCE(MAX(position), 0) + 1 FROM collections WHERE user_id = ?2))`,
      )
      .bind(id, userId, name.trim(), norm(name), icon)
      .run();

    return { id, userId, name: name.trim(), icon };
  }

  /** Сколько записей потеряет коллекцию, если её удалить. */
  async countEntries(userId: number, collectionId: string): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM object_collections oc
         JOIN collections c ON c.id = oc.collection_id AND c.user_id = ?2
         WHERE oc.collection_id = ?1`,
      )
      .bind(collectionId, userId)
      .first<{ n: number }>();

    return row?.n ?? 0;
  }

  /**
   * Удаление раздела.
   *
   * Записи не трогаем: они остаются доступны через «Недавние» и поиск.
   * Молча сносить чужие данные вместе с папкой — худшее, что может
   * сделать хранилище, поэтому непустой раздел удаляется только при
   * `force`, о чём пользователя спрашивают отдельно.
   */
  async delete(userId: number, collectionId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM collections WHERE id = ?1 AND user_id = ?2`)
      .bind(collectionId, userId)
      .run();
  }

  /**
   * Переименование. Имя раздела уникально на пользователя, поэтому
   * столкновение объясняем словами, а не роняем запрос.
   */
  async rename(userId: number, collectionId: string, name: string): Promise<string | null> {
    try {
      await this.db
        .prepare(`UPDATE collections SET name = ?3, name_norm = ?4 WHERE id = ?1 AND user_id = ?2`)
        .bind(collectionId, userId, name.trim(), norm(name))
        .run();

      return null;
    } catch (error) {
      if (String(error).includes('UNIQUE')) {
        return 'Раздел с таким названием уже есть.';
      }
      throw error;
    }
  }

  async setIcon(userId: number, collectionId: string, icon: string | null): Promise<void> {
    await this.db
      .prepare(`UPDATE collections SET icon = ?3 WHERE id = ?1 AND user_id = ?2`)
      .bind(collectionId, userId, icon)
      .run();
  }

  async find(userId: number, collectionId: string): Promise<Collection | null> {
    const row = await this.db
      .prepare(`SELECT id, user_id, name, icon FROM collections WHERE id = ?1 AND user_id = ?2`)
      .bind(collectionId, userId)
      .first<CollectionRow>();

    return row ? toCollection(row) : null;
  }

  async findByName(userId: number, name: string): Promise<Collection | null> {
    const row = await this.db
      .prepare(`SELECT id, user_id, name, icon FROM collections WHERE user_id = ?1 AND name_norm = ?2`)
      .bind(userId, norm(name))
      .first<CollectionRow>();

    return row ? toCollection(row) : null;
  }

  async list(userId: number): Promise<Array<Collection & { entryCount: number }>> {
    const { results } = await this.db
      .prepare(
        `SELECT c.id, c.user_id, c.name, c.icon,
                (SELECT COUNT(*) FROM object_collections oc WHERE oc.collection_id = c.id) AS entry_count
         FROM collections c
         WHERE c.user_id = ?1
         ORDER BY c.position, c.name`,
      )
      .bind(userId)
      .all<CollectionRow & { entry_count: number }>();

    return results.map((row) => ({ ...toCollection(row), entryCount: row.entry_count }));
  }

  async listForObject(objectId: string): Promise<Collection[]> {
    const { results } = await this.db
      .prepare(
        `SELECT c.id, c.user_id, c.name, c.icon
         FROM object_collections oc
         JOIN collections c ON c.id = oc.collection_id
         WHERE oc.object_id = ?1
         ORDER BY c.position`,
      )
      .bind(objectId)
      .all<CollectionRow>();

    return results.map(toCollection);
  }
}
