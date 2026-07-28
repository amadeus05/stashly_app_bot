import { coerceValue, inferValue } from '../domain/property.js';
import type { MatchSite } from '../domain/highlight.js';
import { findSites, termsOf } from '../domain/highlight.js';
import type { ParsedQuery } from '../domain/query.js';
import { parseQuery } from '../domain/query.js';
import type { Collection, EntryCard, PropertyType, SearchHit, StoredObject } from '../domain/types.js';
import { CollectionRepository } from '../infrastructure/d1/collections.js';
import type { NewMedia } from '../infrastructure/d1/entries.js';
import { EntryRepository } from '../infrastructure/d1/entries.js';
import { FieldRepository } from '../infrastructure/d1/fields.js';
import { SearchRepository } from '../infrastructure/d1/search.js';
import { StateRepository } from '../infrastructure/d1/state.js';
import { ReminderRepository } from '../infrastructure/d1/reminders.js';
import { TagRepository } from '../infrastructure/d1/tags.js';
import { UserRepository } from '../infrastructure/d1/users.js';

export const PAGE_SIZE = 8;

export interface Page<T> {
  items: T[];
  page: number;
  hasMore: boolean;
  /** Известно, только когда список посчитан целиком — для счётчика «2/3». */
  pages?: number;
  /** Сколько всего нашлось — показываем в заголовке выдачи. */
  total?: number;
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
  readonly fields: FieldRepository;
  readonly tagBook: TagRepository;
  readonly reminders: ReminderRepository;

  constructor(db: D1Database) {
    this.users = new UserRepository(db);
    this.collections = new CollectionRepository(db);
    this.entries = new EntryRepository(db);
    this.search = new SearchRepository(db);
    this.state = new StateRepository(db);
    this.fields = new FieldRepository(db);
    this.tagBook = new TagRepository(db);
    this.reminders = new ReminderRepository(db);
  }

  /**
   * Записывает значение с проверкой по объявленному типу поля.
   *
   * Возвращает текст проблемы, если значение не подошло — вызывающий
   * покажет его и оставит мастер открытым, а не потеряет ввод.
   */
  async setValidatedProperty(
    userId: number,
    objectId: string,
    key: string,
    rawValue: string,
    expected: PropertyType | null,
  ): Promise<string | null> {
    const { value, problem } = coerceValue(rawValue, expected);
    if (!value) return problem;

    await this.entries.setProperty(userId, objectId, key, value);
    await this.search.flushDirty();
    return null;
  }

  /** Поля справочника, применимые к объекту, с учётом его разделов. */
  async fieldsFor(userId: number, objectId: string, type: 'entry' | 'attachment' | 'note') {
    if (type === 'note') return [];

    const collections = await this.collections.listForObject(objectId);
    const ids = collections.map((collection) => collection.id);

    // У вложения своих разделов нет — берём разделы родительской записи.
    if (ids.length === 0) {
      const parentId = await this.entries.collectionIdOf(objectId);
      if (parentId) ids.push(parentId);
    }

    return this.fields.forObject(userId, type, ids);
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

  /** Повесить уже существующий тег — выбором из списка, а не вводом имени. */
  async attachTag(userId: number, objectId: string, tagId: string): Promise<void> {
    await this.entries.attachTag(userId, objectId, tagId);
    await this.search.flushDirty();
  }

  async removeTag(userId: number, objectId: string, tagId: string): Promise<void> {
    await this.entries.removeTag(userId, objectId, tagId);
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

  /** Расшифровка речи — отдельным шагом: она приходит позже самого файла. */
  async setTranscript(attachmentId: string, transcript: string): Promise<void> {
    await this.entries.setTranscript(attachmentId, transcript);
    await this.search.flushDirty();
  }

  async attachMedia(userId: number, entryId: string, media: NewMedia): Promise<string> {
    const id = await this.entries.addAttachment(userId, entryId, media);
    await this.search.flushDirty();
    return id;
  }

  async find(userId: number, rawQuery: string, page = 0): Promise<Page<SearchHit>> {
    return this.findParsed(userId, parseQuery(rawQuery), page);
  }

  /**
   * Дополняет выдачу местами совпадения.
   *
   * Один запрос на всю страницу: восемь записей, десятки строк. Само
   * сопоставление — в домене, потому что LOWER() в SQLite не понимает
   * кириллицу и сравнение без учёта регистра в SQL не работает.
   */
  async sitesFor(
    userId: number,
    hits: SearchHit[],
    query: ParsedQuery,
  ): Promise<Map<string, MatchSite[]>> {
    const sites = new Map<string, MatchSite[]>();
    const ids = [...new Set(hits.map((hit) => hit.entryId))];
    if (ids.length === 0) return sites;

    const contents = await this.entries.contentsOf(userId, ids);

    // Слова запроса плюс имена полей из фильтров: «оценка>=9» тоже
    // должна показать, какое поле прошло условие.
    const terms = [...termsOf(query.text), ...query.properties.map((filter) => filter.key.toLowerCase())];

    for (const id of ids) {
      const found = findSites(terms, contents.get(id) ?? []);
      if (found.length > 0) sites.set(id, found);
    }

    return sites;
  }

  /** Тот же поиск, но по готовой структуре — её собирает разбор речи. */
  async findParsed(userId: number, query: ParsedQuery, page = 0): Promise<Page<SearchHit>> {
    const { hits, total } = await this.search.search(userId, query, PAGE_SIZE, page * PAGE_SIZE);

    return {
      items: hits,
      page,
      hasMore: (page + 1) * PAGE_SIZE < total,
      pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      total,
    };
  }

  /** Что подставить модели в промпт: только то, что у пользователя есть. */
  async intentContext(userId: number): Promise<{ collections: string[]; tags: string[]; keys: string[] }> {
    const [collections, tags, keys] = await Promise.all([
      this.collections.list(userId),
      this.tagBook.list(userId, null, 'asc'),
      this.entries.suggestKeys(userId, 'entry', null, 40),
    ]);

    return {
      collections: collections.map((item) => item.name),
      tags: tags.map((item) => item.name),
      keys,
    };
  }

  async card(userId: number, entryId: string): Promise<EntryCard | null> {
    return this.entries.getCard(userId, entryId);
  }

  async recent(userId: number, page = 0): Promise<Page<StoredObject>> {
    const [rows, total] = await Promise.all([
      this.entries.listRecent(userId, PAGE_SIZE + 1, page * PAGE_SIZE),
      this.entries.countEntries(userId),
    ]);

    return { ...paginate(rows, page), pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
  }

  async byCollection(userId: number, collectionId: string, page = 0): Promise<Page<StoredObject>> {
    const [rows, total] = await Promise.all([
      this.entries.listByCollection(userId, collectionId, PAGE_SIZE + 1, page * PAGE_SIZE),
      this.collections.countEntries(userId, collectionId),
    ]);

    return { ...paginate(rows, page), pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
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
    transcript?: string,
  ): Promise<string> {
    const entryId = await this.entries.createEntry(userId, title, [collectionId]);
    if (media) {
      const attachmentId = await this.entries.addAttachment(userId, entryId, media);
      if (transcript) await this.entries.setTranscript(attachmentId, transcript);
    }
    await this.search.flushDirty();
    return entryId;
  }
}
