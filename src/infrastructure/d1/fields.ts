import { newId, norm } from '../../core/id.js';
import type { ObjectType, PropertyType } from '../../domain/types.js';

/** Куда применимо поле. 'any' — и к записям, и к вложениям. */
export type FieldTarget = 'entry' | 'attachment' | 'any';

export interface FieldDef {
  id: string;
  key: string;
  /** null — тип не задан, определится по первому значению. */
  type: PropertyType | null;
  /** null — поле общее. */
  collectionId: string | null;
  collectionName: string | null;
  target: FieldTarget;
  optionCount: number;
}

export interface FieldOption {
  id: string;
  value: string;
}

/** 'global' — только общие, иначе id раздела, null — все. */
export type FieldFilter = string | null;
export type FieldSort = 'asc' | 'desc';

interface DefRow {
  id: string;
  key: string;
  type: PropertyType | null;
  collection_id: string | null;
  collection_name: string | null;
  target: FieldTarget;
  option_count: number;
}

const toDef = (row: DefRow): FieldDef => ({
  id: row.id,
  key: row.key,
  type: row.type,
  collectionId: row.collection_id,
  collectionName: row.collection_name,
  target: row.target,
  optionCount: row.option_count,
});

const SELECT_DEF = `
  SELECT f.id, f.key, f.type, f.collection_id, f.target,
         c.name AS collection_name,
         (SELECT COUNT(*) FROM field_options o WHERE o.field_def_id = f.id) AS option_count
  FROM field_defs f
  LEFT JOIN collections c ON c.id = f.collection_id`;

export class FieldRepository {
  constructor(private readonly db: D1Database) {}

  /**
   * Справочник целиком, с фильтром и сортировкой.
   *
   * Пагинацию делает вызывающий: полей у одного человека десятки, а не
   * тысячи, и лишний COUNT ради номера страницы дороже, чем выбрать всё.
   */
  async list(userId: number, filter: FieldFilter, sort: FieldSort): Promise<FieldDef[]> {
    const scope =
      filter === null
        ? ''
        : filter === 'global'
          ? 'AND f.collection_id IS NULL'
          : 'AND f.collection_id = ?2';

    // Направление подставляем сами: имя столбца и ASC/DESC параметром не
    // передаются, но значение приходит не от пользователя, а из типа.
    const direction = sort === 'desc' ? 'DESC' : 'ASC';

    const statement = this.db.prepare(
      `${SELECT_DEF} WHERE f.user_id = ?1 ${scope} ORDER BY c.name IS NULL DESC, c.name COLLATE NOCASE, f.key COLLATE NOCASE ${direction}`,
    );

    const bound =
      filter !== null && filter !== 'global' ? statement.bind(userId, filter) : statement.bind(userId);

    const { results } = await bound.all<DefRow>();
    return results.map(toDef);
  }

  /**
   * Поля, применимые к объекту: общие плюс поля его разделов.
   *
   * Запись может лежать в нескольких разделах — тогда берём объединение.
   */
  async forObject(userId: number, type: ObjectType, collectionIds: string[]): Promise<FieldDef[]> {
    const placeholders = collectionIds.map((_, index) => `?${index + 3}`).join(', ');
    const scope = collectionIds.length > 0 ? `OR f.collection_id IN (${placeholders})` : '';

    const { results } = await this.db
      .prepare(
        `${SELECT_DEF}
         WHERE f.user_id = ?1
           AND (f.target = ?2 OR f.target = 'any')
           AND (f.collection_id IS NULL ${scope})
         ORDER BY f.collection_id IS NULL, f.key COLLATE NOCASE`,
      )
      .bind(userId, type, ...collectionIds)
      .all<DefRow>();

    return results.map(toDef);
  }

  async find(userId: number, defId: string): Promise<FieldDef | null> {
    const row = await this.db
      .prepare(`${SELECT_DEF} WHERE f.user_id = ?1 AND f.id = ?2`)
      .bind(userId, defId)
      .first<DefRow>();

    return row ? toDef(row) : null;
  }

  async create(
    userId: number,
    key: string,
    type: PropertyType | null,
    collectionId: string | null,
    target: FieldTarget,
  ): Promise<string> {
    const id = newId();
    await this.db
      .prepare(
        `INSERT INTO field_defs(id, user_id, key, key_norm, type, collection_id, target)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT DO NOTHING`,
      )
      .bind(id, userId, key.trim(), norm(key), type, collectionId, target)
      .run();

    // ON CONFLICT DO NOTHING — значит такое поле уже есть; возвращаем его.
    const existing = await this.db
      .prepare(
        `SELECT id FROM field_defs
         WHERE user_id = ?1 AND key_norm = ?2 AND COALESCE(collection_id, '') = ?3 AND target = ?4`,
      )
      .bind(userId, norm(key), collectionId ?? '', target)
      .first<{ id: string }>();

    return existing?.id ?? id;
  }

  async delete(userId: number, defId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM field_defs WHERE id = ?1 AND user_id = ?2`)
      .bind(defId, userId)
      .run();
  }

  /**
   * Правка поля. Имя, область и применимость входят в уникальный индекс,
   * поэтому изменение любого из них может столкнуться с существующим
   * полем — возвращаем это словами, а не пятисотой ошибкой.
   */
  private async update(
    userId: number,
    defId: string,
    column: 'key' | 'collection_id' | 'target' | 'type',
    value: string | null,
    extra?: { key_norm: string },
  ): Promise<string | null> {
    const sql = extra
      ? `UPDATE field_defs SET key = ?3, key_norm = ?4 WHERE id = ?1 AND user_id = ?2`
      : `UPDATE field_defs SET ${column} = ?3 WHERE id = ?1 AND user_id = ?2`;

    try {
      const statement = this.db.prepare(sql);
      await (extra ? statement.bind(defId, userId, value, extra.key_norm) : statement.bind(defId, userId, value)).run();
      return null;
    } catch (error) {
      if (String(error).includes('UNIQUE')) {
        return 'Такое поле уже есть — имя должно быть уникальным в своей области.';
      }
      throw error;
    }
  }

  async rename(userId: number, defId: string, key: string): Promise<string | null> {
    return this.update(userId, defId, 'key', key.trim(), { key_norm: norm(key) });
  }

  async setType(userId: number, defId: string, type: PropertyType | null): Promise<string | null> {
    return this.update(userId, defId, 'type', type);
  }

  async setScope(userId: number, defId: string, collectionId: string | null): Promise<string | null> {
    return this.update(userId, defId, 'collection_id', collectionId);
  }

  async setTarget(userId: number, defId: string, target: FieldTarget): Promise<string | null> {
    return this.update(userId, defId, 'target', target);
  }

  /**
   * Сколько уже записанных значений не совпадёт с новым типом.
   *
   * Смена типа не переписывает данные — она включает проверку для нового
   * ввода. Старые значения останутся как есть, и молчать об этом нельзя:
   * человек решит, что теперь всё поле числовое, а фильтры их не увидят.
   */
  async countMismatched(userId: number, defId: string, type: PropertyType): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM properties p
         JOIN field_defs f ON f.key_norm = p.key_norm AND f.user_id = p.user_id
         WHERE f.id = ?1 AND p.user_id = ?2 AND p.type <> ?3`,
      )
      .bind(defId, userId, type)
      .first<{ n: number }>();

    return row?.n ?? 0;
  }

  // --- значения ------------------------------------------------------------

  async options(defId: string): Promise<FieldOption[]> {
    const { results } = await this.db
      .prepare(`SELECT id, value FROM field_options WHERE field_def_id = ?1 ORDER BY position, value`)
      .bind(defId)
      .all<FieldOption>();

    return results;
  }

  /** Добавляет значения пачкой: пользователь вводит их через запятую. */
  async addOptions(defId: string, values: string[]): Promise<void> {
    const clean = values.map((value) => value.trim()).filter((value) => value.length > 0);
    if (clean.length === 0) return;

    await this.db.batch(
      clean.map((value, index) =>
        this.db
          .prepare(
            `INSERT INTO field_options(id, field_def_id, value, value_norm, position)
             VALUES (?1, ?2, ?3, ?4,
                     (SELECT COALESCE(MAX(position), 0) + 1 + ?5 FROM field_options WHERE field_def_id = ?2))
             ON CONFLICT DO NOTHING`,
          )
          .bind(newId(), defId, value, norm(value), index),
      ),
    );
  }

  /**
   * Переименовывает значение.
   *
   * Возвращает id поля либо текст проблемы: значения уникальны в пределах
   * поля, и переименование в уже существующее должно объясняться словами.
   */
  async renameOption(
    userId: number,
    optionId: string,
    value: string,
  ): Promise<{ defId: string | null; problem: string | null }> {
    const row = await this.db
      .prepare(
        `SELECT o.field_def_id AS id FROM field_options o
         JOIN field_defs f ON f.id = o.field_def_id
         WHERE o.id = ?1 AND f.user_id = ?2`,
      )
      .bind(optionId, userId)
      .first<{ id: string }>();

    if (!row) return { defId: null, problem: 'Значение не найдено.' };

    try {
      await this.db
        .prepare(`UPDATE field_options SET value = ?2, value_norm = ?3 WHERE id = ?1`)
        .bind(optionId, value.trim(), norm(value))
        .run();

      return { defId: row.id, problem: null };
    } catch (error) {
      if (String(error).includes('UNIQUE')) {
        return { defId: row.id, problem: 'Такое значение у этого поля уже есть.' };
      }
      throw error;
    }
  }

  /**
   * Удаляет значение и возвращает поле, которому оно принадлежало.
   *
   * id значения приходит из callback_data, то есть с клиента — проверяем
   * владельца через связь с полем, а не доверяем присланному.
   */
  async deleteOption(userId: number, optionId: string): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT o.field_def_id AS id FROM field_options o
         JOIN field_defs f ON f.id = o.field_def_id
         WHERE o.id = ?1 AND f.user_id = ?2`,
      )
      .bind(optionId, userId)
      .first<{ id: string }>();

    if (!row) return null;

    await this.db.prepare(`DELETE FROM field_options WHERE id = ?1`).bind(optionId).run();
    return row.id;
  }

  // --- настройки экрана ----------------------------------------------------

  async preferences(userId: number): Promise<{ sort: FieldSort; filter: FieldFilter }> {
    const row = await this.db
      .prepare(`SELECT fields_sort, fields_filter FROM users WHERE id = ?1`)
      .bind(userId)
      .first<{ fields_sort: FieldSort; fields_filter: string | null }>();

    return { sort: row?.fields_sort ?? 'asc', filter: row?.fields_filter ?? null };
  }

  async setPreferences(userId: number, sort: FieldSort, filter: FieldFilter): Promise<void> {
    await this.db
      .prepare(`UPDATE users SET fields_sort = ?2, fields_filter = ?3 WHERE id = ?1`)
      .bind(userId, sort, filter)
      .run();
  }
}
