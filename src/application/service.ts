import { inferValue } from '../domain/property.js';
import { parseQuery } from '../domain/query.js';
import type { Collection, EntryCard, SearchHit, StoredObject } from '../domain/types.js';
import { CollectionRepository } from '../infrastructure/d1/collections.js';
import type { NewMedia } from '../infrastructure/d1/entries.js';
import { EntryRepository } from '../infrastructure/d1/entries.js';
import { SearchRepository } from '../infrastructure/d1/search.js';
import { StateRepository } from '../infrastructure/d1/state.js';
import { UserRepository } from '../infrastructure/d1/users.js';

export const PAGE_SIZE = 8;

export interface Page<T> {
  items: T[];
  page: number;
  hasMore: boolean;
}

/**
 * Запрашиваем на один элемент больше, чем показываем.
 *
 * Так наличие следующей страницы известно без отдельного COUNT(*),
 * который на каждом листании стоил бы второго запроса к D1.
 */
function paginate<T>(rows: T[], page: number): Page<T> {
  return { items: rows.slice(0, PAGE_SIZE), page, hasMore: rows.length > PAGE_SIZE };
}

/**
 * Прикладной слой: сценарии целиком, без знания о Telegram.
 *
 * Каждая мутация заканчивается разбором очереди переиндексации — так
 * запись становится находимой сразу же, а не через крон.
 */
export class NoteKeeper {
  readonly users: UserRepository;
  readonly collections: CollectionRepository;
  readonly entries: EntryRepository;
  readonly search: SearchRepository;
  readonly state: StateRepository;

  constructor(db: D1Database) {
    this.users = new UserRepository(db);
    this.collections = new CollectionRepository(db);
    this.entries = new EntryRepository(db);
    this.search = new SearchRepository(db);
    this.state = new StateRepository(db);
  }

  async createCollection(userId: number, name: string, icon: string | null): Promise<Collection> {
    const existing = await this.collections.findByName(userId, name);
    if (existing) return existing;
    return this.collections.create(userId, name, icon);
  }

  /**
   * Пригодно ли это как название раздела.
   *
   * Живой запуск показал сценарий, которого не было в тестах: пользователь
   * копирует пример фильтров из подсказки бота и вставляет его в мастер.
   * Получается раздел с именем «раздел:донхуа оценка>=9 tag:любимое».
   */
  static validateName(name: string): string | null {
    const trimmed = name.trim();

    if (trimmed.length === 0) return 'Название не может быть пустым.';
    if (trimmed.length > CollectionRepository.MAX_NAME) {
      return `Слишком длинное название — максимум ${CollectionRepository.MAX_NAME} символов.`;
    }
    if (/^\/|^[a-zа-я]+:\S/i.test(trimmed) || /[<>]=|\s\S+:\S/.test(trimmed)) {
      return 'Похоже, это поисковый запрос, а не название раздела.';
    }
    return null;
  }

  async deleteCollection(userId: number, collectionId: string): Promise<void> {
    await this.collections.delete(userId, collectionId);
  }

  async deleteProperty(userId: number, propertyId: string): Promise<string | null> {
    const objectId = await this.entries.deleteProperty(userId, propertyId);
    await this.search.flushDirty();
    return objectId;
  }

  async removeTag(objectId: string, tagId: string): Promise<void> {
    await this.entries.removeTag(objectId, tagId);
    await this.search.flushDirty();
  }

  async deleteObject(userId: number, objectId: string): Promise<void> {
    await this.entries.delete(userId, objectId);
    await this.search.flushDirty();
  }

  async createEntry(userId: number, title: string, collectionId: string): Promise<string> {
    const id = await this.entries.createEntry(userId, title, [collectionId]);
    await this.search.flushDirty();
    return id;
  }

  async setProperty(userId: number, objectId: string, key: string, rawValue: string): Promise<void> {
    await this.entries.setProperty(userId, objectId, key, inferValue(rawValue));
    await this.search.flushDirty();
  }

  async addTag(userId: number, objectId: string, name: string): Promise<void> {
    await this.entries.addTag(userId, objectId, name.replace(/^#/, ''));
    await this.search.flushDirty();
  }

  async addNote(userId: number, parentId: string, text: string): Promise<string> {
    const id = await this.entries.addNote(userId, parentId, text);
    await this.search.flushDirty();
    return id;
  }

  async attachMedia(userId: number, entryId: string, media: NewMedia): Promise<string> {
    const id = await this.entries.addAttachment(userId, entryId, media);
    await this.search.flushDirty();
    return id;
  }

  async find(userId: number, rawQuery: string, page = 0): Promise<Page<SearchHit>> {
    const hits = await this.search.search(userId, parseQuery(rawQuery), PAGE_SIZE + 1, page * PAGE_SIZE);
    return paginate(hits, page);
  }

  async card(userId: number, entryId: string): Promise<EntryCard | null> {
    return this.entries.getCard(userId, entryId);
  }

  async recent(userId: number, page = 0): Promise<Page<StoredObject>> {
    const rows = await this.entries.listRecent(userId, PAGE_SIZE + 1, page * PAGE_SIZE);
    return paginate(rows, page);
  }

  async byCollection(collectionId: string, page = 0): Promise<Page<StoredObject>> {
    const rows = await this.entries.listByCollection(collectionId, PAGE_SIZE + 1, page * PAGE_SIZE);
    return paginate(rows, page);
  }

  /**
   * Сохранение того, что пользователь прислал: текст или медиа.
   *
   * Это основной вход в продукт — не команды. Пользователь пересылает
   * сообщение, выбирает раздел, и запись готова.
   */
  async saveIncoming(
    userId: number,
    collectionId: string,
    title: string,
    media: NewMedia | null,
  ): Promise<string> {
    const entryId = await this.entries.createEntry(userId, title, [collectionId]);
    if (media) {
      await this.entries.addAttachment(userId, entryId, media);
    }
    await this.search.flushDirty();
    return entryId;
  }
}
