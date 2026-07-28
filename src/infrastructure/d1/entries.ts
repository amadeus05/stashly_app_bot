import { newId, norm } from '../../core/id.js';
import { nowIso } from '../../core/time.js';
import type { TypedValue } from '../../domain/property.js';
import type {
  Attachment,
  EntryCard,
  MediaType,
  ObjectType,
  Property,
  StoredObject,
  Tag,
} from '../../domain/types.js';
import { CollectionRepository } from './collections.js';

interface ObjectRow {
  id: string;
  user_id: number;
  type: ObjectType;
  parent_id: string | null;
  title: string | null;
  body: string | null;
  created_at: string;
  updated_at: string;
}

interface PropertyRow {
  id: string;
  object_id: string;
  key: string;
  type: Property['type'];
  value_text: string | null;
  value_num: number | null;
  value_date: string | null;
}

interface AttachmentRow {
  object_id: string;
  media_type: MediaType;
  file_id: string;
  file_unique_id: string;
  caption: string | null;
}

const toObject = (row: ObjectRow): StoredObject => ({
  id: row.id,
  userId: row.user_id,
  type: row.type,
  parentId: row.parent_id,
  title: row.title,
  body: row.body,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toProperty = (row: PropertyRow): Property => ({
  id: row.id,
  objectId: row.object_id,
  key: row.key,
  type: row.type,
  valueText: row.value_text,
  valueNum: row.value_num,
  valueDate: row.value_date,
});

export interface NewMedia {
  mediaType: MediaType;
  fileId: string;
  fileUniqueId: string;
  mimeType?: string | null;
  fileSize?: number | null;
  duration?: number | null;
  width?: number | null;
  height?: number | null;
  caption?: string | null;
}

export class EntryRepository {
  private readonly collections: CollectionRepository;

  constructor(private readonly db: D1Database) {
    this.collections = new CollectionRepository(db);
  }

  /**
   * Запись и её привязка к коллекциям создаются одним batch'ем.
   * В D1 нет BEGIN/COMMIT, batch — единственный способ не оставить
   * запись без коллекции, если воркер умрёт на полпути.
   */
  async createEntry(userId: number, title: string, collectionIds: string[]): Promise<string> {
    const id = newId();

    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(`INSERT INTO objects(id, user_id, type, title) VALUES (?1, ?2, 'entry', ?3)`)
        .bind(id, userId, title.trim()),
      ...collectionIds.map((collectionId) =>
        this.db.prepare(`INSERT INTO object_collections VALUES (?1, ?2)`).bind(id, collectionId),
      ),
    ];

    await this.db.batch(statements);
    return id;
  }

  async findById(userId: number, objectId: string): Promise<StoredObject | null> {
    const row = await this.db
      .prepare(`SELECT * FROM objects WHERE id = ?1 AND user_id = ?2`)
      .bind(objectId, userId)
      .first<ObjectRow>();

    return row ? toObject(row) : null;
  }

  /** Полная карточка. Пять запросов вместо одного join'а с декартовым взрывом. */
  async getCard(userId: number, entryId: string): Promise<EntryCard | null> {
    const entry = await this.findById(userId, entryId);
    if (!entry || entry.type !== 'entry') return null;

    const [children, properties, tags, attachments, collections] = await Promise.all([
      this.db
        .prepare(`SELECT * FROM objects WHERE parent_id = ?1 ORDER BY position, created_at`)
        .bind(entryId)
        .all<ObjectRow>(),
      this.db
        .prepare(
          `SELECT p.* FROM properties p
           JOIN objects o ON o.id = p.object_id
           WHERE o.id = ?1 OR o.parent_id = ?1
           ORDER BY p.position`,
        )
        .bind(entryId)
        .all<PropertyRow>(),
      this.db
        .prepare(
          `SELECT t.id, t.name FROM object_tags ot
           JOIN tags t ON t.id = ot.tag_id
           WHERE ot.object_id = ?1
           ORDER BY t.name`,
        )
        .bind(entryId)
        .all<Tag>(),
      this.db
        .prepare(
          `SELECT a.* FROM attachments a
           JOIN objects o ON o.id = a.object_id
           WHERE o.parent_id = ?1`,
        )
        .bind(entryId)
        .all<AttachmentRow>(),
      this.collections.listForObject(entryId),
    ]);

    const byObject = new Map<string, Property[]>();
    for (const row of properties.results) {
      const list = byObject.get(row.object_id) ?? [];
      list.push(toProperty(row));
      byObject.set(row.object_id, list);
    }

    const attachmentByObject = new Map(attachments.results.map((row) => [row.object_id, row]));

    return {
      entry,
      collections,
      properties: byObject.get(entryId) ?? [],
      tags: tags.results,
      attachments: children.results
        .filter((row) => row.type === 'attachment')
        .flatMap((row) => {
          const media = attachmentByObject.get(row.id);
          if (!media) return [];
          const attachment: Attachment = {
            objectId: media.object_id,
            mediaType: media.media_type,
            fileId: media.file_id,
            fileUniqueId: media.file_unique_id,
            caption: media.caption,
          };
          return [{ object: toObject(row), attachment, properties: byObject.get(row.id) ?? [] }];
        }),
      notes: children.results.filter((row) => row.type === 'note').map(toObject),
    };
  }

  /**
   * Вложение как самостоятельный объект: со своими свойствами и заметками.
   * getCard их не отдаёт — он собирает только потомков записи.
   */
  async getAttachment(
    userId: number,
    attachmentId: string,
  ): Promise<{
    object: StoredObject;
    attachment: Attachment;
    properties: Property[];
    notes: StoredObject[];
  } | null> {
    const object = await this.findById(userId, attachmentId);
    if (!object || object.type !== 'attachment') return null;

    const [media, properties, notes] = await Promise.all([
      this.db
        .prepare(`SELECT * FROM attachments WHERE object_id = ?1`)
        .bind(attachmentId)
        .first<AttachmentRow>(),
      this.db
        .prepare(`SELECT * FROM properties WHERE object_id = ?1 ORDER BY position`)
        .bind(attachmentId)
        .all<PropertyRow>(),
      this.db
        .prepare(`SELECT * FROM objects WHERE parent_id = ?1 AND type = 'note' ORDER BY position`)
        .bind(attachmentId)
        .all<ObjectRow>(),
    ]);

    if (!media) return null;

    return {
      object,
      attachment: {
        objectId: media.object_id,
        mediaType: media.media_type,
        fileId: media.file_id,
        fileUniqueId: media.file_unique_id,
        caption: media.caption,
      },
      properties: properties.results.map(toProperty),
      notes: notes.results.map(toObject),
    };
  }

  /**
   * Всё, что можно снять с объекта. Работает и для записи, и для вложения:
   * свойства и заметки устроены одинаково на любом уровне.
   */
  async getRemovable(
    userId: number,
    objectId: string,
  ): Promise<{ object: StoredObject; properties: Property[]; tags: Tag[]; notes: StoredObject[] } | null> {
    const object = await this.findById(userId, objectId);
    if (!object) return null;

    const [properties, tags, notes] = await Promise.all([
      this.db
        .prepare(`SELECT * FROM properties WHERE object_id = ?1 ORDER BY position`)
        .bind(objectId)
        .all<PropertyRow>(),
      this.db
        .prepare(
          `SELECT t.id, t.name FROM object_tags ot
           JOIN tags t ON t.id = ot.tag_id
           WHERE ot.object_id = ?1 ORDER BY t.name`,
        )
        .bind(objectId)
        .all<Tag>(),
      this.db
        .prepare(`SELECT * FROM objects WHERE parent_id = ?1 AND type = 'note' ORDER BY position`)
        .bind(objectId)
        .all<ObjectRow>(),
    ]);

    return {
      object,
      properties: properties.results.map(toProperty),
      tags: tags.results,
      notes: notes.results.map(toObject),
    };
  }

  /** Свойство по id — чтобы открыть его на правку, зная только кнопку. */
  async findProperty(userId: number, propertyId: string): Promise<{ objectId: string; key: string } | null> {
    const row = await this.db
      .prepare(`SELECT object_id, key FROM properties WHERE id = ?1 AND user_id = ?2`)
      .bind(propertyId, userId)
      .first<{ object_id: string; key: string }>();

    return row ? { objectId: row.object_id, key: row.key } : null;
  }

  /** Правка текста заметки на месте, без удаления и создания заново. */
  async updateNote(userId: number, noteId: string, text: string): Promise<string | null> {
    const note = await this.findById(userId, noteId);
    if (!note || note.type !== 'note') return null;

    await this.db
      .prepare(`UPDATE objects SET body = ?3, updated_at = ?4 WHERE id = ?1 AND user_id = ?2`)
      .bind(noteId, userId, text.trim(), nowIso())
      .run();

    if (note.parentId) await this.touch(note.parentId);
    return note.parentId;
  }

  /** Свойство удаляется по своему id; триггер сам пометит объект на переиндексацию. */
  async deleteProperty(userId: number, propertyId: string): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT object_id FROM properties WHERE id = ?1 AND user_id = ?2`)
      .bind(propertyId, userId)
      .first<{ object_id: string }>();

    if (!row) return null;

    await this.db.prepare(`DELETE FROM properties WHERE id = ?1 AND user_id = ?2`).bind(propertyId, userId).run();
    await this.touch(row.object_id);
    return row.object_id;
  }

  /**
   * Снимаем тег с объекта, но сам тег у пользователя оставляем:
   * он может висеть на других записях, и удалять его целиком нельзя.
   */
  async removeTag(objectId: string, tagId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM object_tags WHERE object_id = ?1 AND tag_id = ?2`)
      .bind(objectId, tagId)
      .run();

    await this.touch(objectId);
  }

  async listRecent(userId: number, limit: number, offset: number): Promise<StoredObject[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM objects
         WHERE user_id = ?1 AND type = 'entry'
         ORDER BY updated_at DESC
         LIMIT ?2 OFFSET ?3`,
      )
      .bind(userId, limit, offset)
      .all<ObjectRow>();

    return results.map(toObject);
  }

  async listByCollection(collectionId: string, limit: number, offset: number): Promise<StoredObject[]> {
    const { results } = await this.db
      .prepare(
        `SELECT o.* FROM objects o
         JOIN object_collections oc ON oc.object_id = o.id
         WHERE oc.collection_id = ?1
         ORDER BY o.updated_at DESC
         LIMIT ?2 OFFSET ?3`,
      )
      .bind(collectionId, limit, offset)
      .all<ObjectRow>();

    return results.map(toObject);
  }

  async countEntries(userId: number): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM objects WHERE user_id = ?1 AND type = 'entry'`)
      .bind(userId)
      .first<{ n: number }>();

    return row?.n ?? 0;
  }

  /**
   * Теги для быстрого выбора.
   *
   * Сверху — те, что уже встречались в этом разделе: раскладка «донхуа»
   * не должна тонуть в тегах рыбалки. LEFT JOIN, чтобы тег, снятый со
   * всех записей, не исчезал из списка навсегда.
   */
  async suggestTags(
    userId: number,
    collectionId: string | null,
    limit: number,
  ): Promise<Array<Tag & { uses: number }>> {
    const { results } = await this.db
      .prepare(
        `SELECT t.id, t.name,
                COUNT(ot.object_id) AS uses,
                COALESCE(SUM(CASE WHEN oc.collection_id = ?2 THEN 1 ELSE 0 END), 0) AS here,
                CASE WHEN t.collection_id = ?2 THEN 1 ELSE 0 END AS mine
         FROM tags t
         LEFT JOIN object_tags ot ON ot.tag_id = t.id
         LEFT JOIN object_collections oc ON oc.object_id = ot.object_id
         WHERE t.user_id = ?1
         GROUP BY t.id
         ORDER BY mine DESC, here DESC, uses DESC, t.name
         LIMIT ?3`,
      )
      .bind(userId, collectionId, limit)
      .all<Tag & { uses: number }>();

    return results;
  }

  /**
   * Названия полей для быстрого выбора.
   *
   * Тип объекта важен: у вложений свои поля («Тайминг», «Серия»), и
   * подсовывать там «Озвучку» от записи бессмысленно.
   */
  async suggestKeys(
    userId: number,
    type: ObjectType,
    collectionId: string | null,
    limit: number,
  ): Promise<string[]> {
    const { results } = await this.db
      .prepare(
        `SELECT p.key AS key, COUNT(*) AS uses,
                COALESCE(SUM(CASE WHEN oc.collection_id = ?3 THEN 1 ELSE 0 END), 0) AS here
         FROM properties p
         JOIN objects o ON o.id = p.object_id
         LEFT JOIN object_collections oc
                ON oc.object_id = COALESCE(o.parent_id, o.id)
         WHERE p.user_id = ?1 AND o.type = ?2
         GROUP BY p.key_norm
         ORDER BY here DESC, uses DESC, p.key
         LIMIT ?4`,
      )
      .bind(userId, type, collectionId, limit)
      .all<{ key: string }>();

    return results.map((row) => row.key);
  }

  /**
   * Вешает существующий тег. Проверка user_id обязательна: id тега
   * приходит из callback_data, то есть с клиента.
   */
  async attachTag(userId: number, objectId: string, tagId: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO object_tags(object_id, tag_id)
         SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM tags WHERE id = ?2 AND user_id = ?3)
         ON CONFLICT DO NOTHING`,
      )
      .bind(objectId, tagId, userId)
      .run();

    await this.touch(objectId);
  }

  /** Какие теги уже стоят — чтобы показать отметки в списке выбора. */
  async tagIdsOf(objectId: string): Promise<string[]> {
    const { results } = await this.db
      .prepare(`SELECT tag_id FROM object_tags WHERE object_id = ?1`)
      .bind(objectId)
      .all<{ tag_id: string }>();

    return results.map((row) => row.tag_id);
  }

  /** Раздел объекта: у вложения он берётся у родительской записи. */
  async collectionIdOf(objectId: string): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT oc.collection_id AS id
         FROM objects o
         LEFT JOIN object_collections oc ON oc.object_id = COALESCE(o.parent_id, o.id)
         WHERE o.id = ?1
         LIMIT 1`,
      )
      .bind(objectId)
      .first<{ id: string | null }>();

    return row?.id ?? null;
  }

  /** Свойство с тем же ключом перезаписывается — ключ уникален в пределах объекта. */
  async setProperty(userId: number, objectId: string, key: string, value: TypedValue): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO properties(id, object_id, user_id, key, key_norm, type, value_text, value_num, value_date, position)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
                 (SELECT COALESCE(MAX(position), 0) + 1 FROM properties WHERE object_id = ?2))
         ON CONFLICT(object_id, key_norm) DO UPDATE SET
           key        = excluded.key,
           type       = excluded.type,
           value_text = excluded.value_text,
           value_num  = excluded.value_num,
           value_date = excluded.value_date`,
      )
      .bind(
        newId(),
        objectId,
        userId,
        key.trim(),
        norm(key),
        value.type,
        value.valueText,
        value.valueNum,
        value.valueDate,
      )
      .run();

    await this.touch(objectId);
  }

  async addTag(userId: number, objectId: string, name: string): Promise<void> {
    const tagId = newId();

    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO tags(id, user_id, name, name_norm) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(user_id, name_norm) DO NOTHING`,
        )
        .bind(tagId, userId, name.trim(), norm(name)),
      this.db
        .prepare(
          `INSERT INTO object_tags(object_id, tag_id)
           SELECT ?1, id FROM tags WHERE user_id = ?2 AND name_norm = ?3
           ON CONFLICT DO NOTHING`,
        )
        .bind(objectId, userId, norm(name)),
    ]);

    await this.touch(objectId);
  }

  async addNote(userId: number, parentId: string, text: string): Promise<string> {
    const id = newId();
    await this.db
      .prepare(
        `INSERT INTO objects(id, user_id, type, parent_id, body, position)
         VALUES (?1, ?2, 'note', ?3, ?4,
                 (SELECT COALESCE(MAX(position), 0) + 1 FROM objects WHERE parent_id = ?3))`,
      )
      .bind(id, userId, parentId, text.trim())
      .run();

    await this.touch(parentId);
    return id;
  }

  async addAttachment(userId: number, entryId: string, media: NewMedia): Promise<string> {
    const id = newId();

    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO objects(id, user_id, type, parent_id, title, position)
           VALUES (?1, ?2, 'attachment', ?3, ?4,
                   (SELECT COALESCE(MAX(position), 0) + 1 FROM objects WHERE parent_id = ?3))`,
        )
        .bind(id, userId, entryId, media.caption ?? null),
      this.db
        .prepare(
          `INSERT INTO attachments(object_id, media_type, file_id, file_unique_id,
                                   mime_type, file_size, duration, width, height, caption)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
        )
        .bind(
          id,
          media.mediaType,
          media.fileId,
          media.fileUniqueId,
          media.mimeType ?? null,
          media.fileSize ?? null,
          media.duration ?? null,
          media.width ?? null,
          media.height ?? null,
          media.caption ?? null,
        ),
    ]);

    await this.touch(entryId);
    return id;
  }

  async delete(userId: number, objectId: string): Promise<void> {
    // Вложения, заметки, свойства и строки индекса уходят каскадом.
    await this.db
      .prepare(`DELETE FROM objects WHERE id = ?1 AND user_id = ?2`)
      .bind(objectId, userId)
      .run();
  }

  /** Правка дочернего объекта должна поднимать запись в "Недавние". */
  private async touch(objectId: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE objects SET updated_at = ?2
         WHERE id = ?1
            OR id = (SELECT parent_id FROM objects WHERE id = ?1)`,
      )
      .bind(objectId, nowIso())
      .run();
  }
}
