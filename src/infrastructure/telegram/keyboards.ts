import { InlineKeyboard } from 'grammy';
import type { Page } from '../../application/service.js';
import type { Collection, EntryCard, SearchHit, StoredObject } from '../../domain/types.js';

/**
 * callback_data ограничен 64 байтами. UUID занимает 36, поэтому префиксы
 * держим в 1-3 символа и никогда не кладём в callback пользовательский текст.
 */
export const CB = {
  menu: 'm',
  collections: 'cs',
  newCollection: 'nc',
  newEntry: 'ne',
  recent: 'r',
  search: 's',
  collection: 'c',
  entry: 'e',
  addProperty: 'p',
  addTag: 't',
  addNote: 'n',
  addMedia: 'a',
  deleteEntry: 'd',
  searchPage: 'sp',
  savePending: 'sv',
  deleteCollection: 'dc',
  attachments: 'as',
  attachment: 'at',
  deleteObject: 'do',
  manage: 'mg',
  deleteProperty: 'dp',
  deleteTag: 'dt',
  deleteNote: 'dn',
} as const;

/**
 * Экран «убрать лишнее».
 *
 * Второй id в callback_data не помещается: 64 байта на два UUID не хватит,
 * поэтому объект, который сейчас правят, лежит в user_state, а в кнопке —
 * только id самого элемента.
 */
export function manageMenu(items: {
  properties: Array<{ id: string; key: string; value: string }>;
  tags: Array<{ id: string; name: string }>;
  notes: Array<{ id: string; body: string | null }>;
  backTo: string;
  isAttachment: boolean;
}): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const property of items.properties) {
    keyboard.text(`🗑 ${property.key}: ${property.value}`.slice(0, 40), `${CB.deleteProperty}:${property.id}`).row();
  }
  for (const tag of items.tags) {
    keyboard.text(`🗑 #${tag.name}`.slice(0, 40), `${CB.deleteTag}:${tag.id}`).row();
  }
  for (const note of items.notes) {
    keyboard.text(`🗑 ${note.body ?? ''}`.slice(0, 40), `${CB.deleteNote}:${note.id}`).row();
  }

  const back = items.isAttachment ? `${CB.attachment}:${items.backTo}` : `${CB.entry}:${items.backTo}`;
  return keyboard.text('⬅️ Назад', back);
}

/**
 * Любой шаг, где бот ждёт ввода, обязан иметь видимый выход.
 * Команда /cancel не в счёт: её никто не угадывает.
 */
export function cancelOnly(): InlineKeyboard {
  return new InlineKeyboard().text('✖️ Отмена', CB.menu);
}

/**
 * Кнопки листания.
 *
 * `prefix` уже содержит всё, кроме номера страницы, — сам запрос в
 * callback_data не кладём: 64 байта на него не хватит, поэтому текст
 * поиска живёт в user_state.
 */
function pager(keyboard: InlineKeyboard, prefix: string, page: Page<unknown>): InlineKeyboard {
  const buttons: Array<[string, string]> = [];
  if (page.page > 0) buttons.push(['⬅️', `${prefix}${page.page - 1}`]);
  if (page.hasMore) buttons.push(['➡️', `${prefix}${page.page + 1}`]);

  if (buttons.length > 0) {
    for (const [label, data] of buttons) keyboard.text(label, data);
    keyboard.row();
  }
  return keyboard;
}

export function mainMenu(entryCount: number, collectionCount: number): InlineKeyboard {
  return new InlineKeyboard()
    .text('➕ Новая запись', CB.newEntry)
    .row()
    .text(`📁 Разделы (${collectionCount})`, CB.collections)
    .text(`🕘 Недавние (${entryCount})`, `${CB.recent}:0`)
    .row()
    .text('🔍 Поиск', CB.search);
}

export function collectionsMenu(collections: Array<Collection & { entryCount: number }>): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const collection of collections) {
    keyboard.text(`${collection.icon ?? '📁'} ${collection.name} · ${collection.entryCount}`, `${CB.collection}:${collection.id}:0`).row();
  }
  return keyboard.text('➕ Новый раздел', CB.newCollection).row().text('⬅️ Меню', CB.menu);
}

export function collectionPicker(collections: Collection[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const collection of collections) {
    keyboard.text(`${collection.icon ?? '📁'} ${collection.name}`, `${CB.collection}:${collection.id}:pick`).row();
  }
  return keyboard.text('➕ Создать раздел', CB.newCollection).row().text('✖️ Отмена', CB.menu);
}

export function cardMenu(card: EntryCard): InlineKeyboard {
  const id = card.entry.id;
  const keyboard = new InlineKeyboard()
    .text('➕ Поле', `${CB.addProperty}:${id}`)
    .text('🏷 Тег', `${CB.addTag}:${id}`)
    .row()
    .text('💬 Заметка', `${CB.addNote}:${id}`)
    .text('📎 Медиа', `${CB.addMedia}:${id}`)
    .row();

  // Вложения бесполезны, если их нельзя открыть.
  if (card.attachments.length > 0) {
    keyboard.text(`🖼 Открыть вложения (${card.attachments.length})`, `${CB.attachments}:${id}`).row();
  }

  // Показываем, только когда есть что убирать.
  if (card.properties.length + card.tags.length + card.notes.length > 0) {
    keyboard.text('✏️ Убрать лишнее', `${CB.manage}:${id}`).row();
  }

  return keyboard.text('🗑 Удалить', `${CB.deleteEntry}:${id}`).text('⬅️ Меню', CB.menu);
}

const MEDIA_ICON: Record<string, string> = {
  photo: '📷',
  video: '🎬',
  audio: '🎵',
  voice: '🎤',
  document: '📄',
  animation: '🎞',
  video_note: '📹',
  sticker: '🩹',
};

export function attachmentList(card: EntryCard): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  card.attachments.forEach((item, index) => {
    const icon = MEDIA_ICON[item.attachment.mediaType] ?? '📎';
    const label = item.object.title ?? `${item.attachment.mediaType} ${index + 1}`;
    keyboard.text(`${icon} ${label}`.slice(0, 40), `${CB.attachment}:${item.object.id}`).row();
  });

  return keyboard.text('⬅️ К записи', `${CB.entry}:${card.entry.id}`);
}

/** Меню под открытым вложением: у него свои свойства и заметки. */
export function attachmentMenu(attachmentId: string, entryId: string, hasItems = false): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text('➕ Поле', `${CB.addProperty}:${attachmentId}`)
    .text('💬 Заметка', `${CB.addNote}:${attachmentId}`)
    .row();

  if (hasItems) {
    keyboard.text('✏️ Убрать лишнее', `${CB.manage}:${attachmentId}`).row();
  }

  return keyboard
    .text('🗑 Удалить вложение', `${CB.deleteObject}:${attachmentId}`)
    .row()
    .text('⬅️ К записи', `${CB.entry}:${entryId}`);
}

export function entryList(
  page: Page<StoredObject>,
  pagePrefix: string,
  collectionId?: string,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const entry of page.items) {
    keyboard.text(`📄 ${entry.title ?? 'Без названия'}`, `${CB.entry}:${entry.id}`).row();
  }
  pager(keyboard, pagePrefix, page);

  if (collectionId) {
    keyboard.text('🗑 Удалить раздел', `${CB.deleteCollection}:${collectionId}`).row();
  }
  return keyboard.text('⬅️ Меню', CB.menu);
}

export function hitList(page: Page<SearchHit>): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const hit of page.items) {
    keyboard.text(`📄 ${hit.entryTitle}`, `${CB.entry}:${hit.entryId}`).row();
  }
  return pager(keyboard, `${CB.searchPage}:`, page).text('⬅️ Меню', CB.menu);
}

/** Ничего не нашлось — предлагаем сохранить сам запрос как новую запись. */
export function saveOffer(): InlineKeyboard {
  return new InlineKeyboard().text('➕ Сохранить как запись', CB.savePending).row().text('⬅️ Меню', CB.menu);
}
