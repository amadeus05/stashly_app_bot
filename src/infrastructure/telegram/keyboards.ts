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
  toggleTag: 'tg',
  newTag: 'tn',
  pickKey: 'pk',
  newKey: 'kn',
  tagPage: 'tp',
  keyPage: 'kp',
  collectionsPage: 'cp',
  noop: 'x',
  fields: 'f',
  fieldsPage: 'fp',
  fieldsSort: 'fs',
  fieldsFilter: 'ff',
  fieldsFilterSet: 'fk',
  field: 'fd',
  fieldNew: 'fnw',
  fieldType: 'ft',
  fieldScope: 'fc',
  fieldDelete: 'fx',
  fieldAddOption: 'fo',
  pickValue: 'pv',
  valuePage: 'vp',
  newValue: 'nv',
  fieldOptions: 'fol',
  optionsPage: 'op',
  deleteOption: 'dox',
  renameOption: 'ron',
  tags: 'tgm',
  tagsPage: 'tgp',
  tagsSort: 'tgo',
  tagsFilter: 'tgf',
  tagsFilterSet: 'tgk',
  tagCard: 'tgc',
  tagNew: 'tgn',
  tagRename: 'tgr',
  tagRescope: 'tgs',
  tagScope: 'tgz',
  tagDelete: 'tgd',
  collectionCard: 'cc',
  collectionRename: 'crn',
  collectionIcon: 'cic',
  fieldRename: 'frn',
  fieldRetype: 'frt',
  fieldRescope: 'frs',
  fieldRetarget: 'frg',
  fieldTarget: 'ftg',
  deleteProperty: 'dp',
  deleteTag: 'dt',
  deleteNote: 'dn',
} as const;

/** Экран справочника: сортировка, фильтр, поля, листалка. */
export function fieldsMenu(
  defs: Array<{ id: string; key: string; collectionName: string | null; optionCount: number; target: string }>,
  page: number,
  sort: 'asc' | 'desc',
  filterLabel: string,
): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text(sort === 'asc' ? '🔤 А→Я' : '🔤 Я→А', `${CB.fieldsSort}:${sort === 'asc' ? 'desc' : 'asc'}`)
    .text(`🔎 ${filterLabel}`, CB.fieldsFilter)
    .row();

  const chunk = slice(defs, page);
  for (const def of chunk.items) {
    // Значок сразу говорит про область: общее поле или привязанное.
    const scope = def.collectionName ? `📌 ${def.collectionName}` : '🌐';
    const values = def.optionCount > 0 ? ` · ${def.optionCount} знач.` : '';
    const where = def.target === 'attachment' ? ' · вложения' : '';
    keyboard.text(`${scope} ${def.key}${values}${where}`.slice(0, 40), `${CB.field}:${def.id}`).row();
  }

  counterPager(keyboard, `${CB.fieldsPage}:`, chunk.page, chunk.pages);
  return keyboard.text('➕ Новое поле', CB.fieldNew).row().text('⬅️ Меню', CB.menu);
}

export function fieldFilterMenu(collections: Array<{ id: string; name: string; icon: string | null }>): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text('Все поля', `${CB.fieldsFilterSet}:all`)
    .row()
    .text('🌐 Только общие', `${CB.fieldsFilterSet}:global`)
    .row();

  for (const collection of collections) {
    keyboard.text(`${collection.icon ?? '📁'} ${collection.name}`, `${CB.fieldsFilterSet}:${collection.id}`).row();
  }

  return keyboard.text('⬅️ Назад', CB.fields);
}

export function fieldCard(defId: string, hasOptions: boolean): InlineKeyboard {
  const keyboard = new InlineKeyboard().text('➕ Значения', `${CB.fieldAddOption}:${defId}`);

  if (hasOptions) {
    keyboard.text('✏️ Править значения', `${CB.fieldOptions}:${defId}`);
  }

  return keyboard
    .row()
    .text('✏️ Имя', `${CB.fieldRename}:${defId}`)
    .text('🔤 Тип', `${CB.fieldRetype}:${defId}`)
    .row()
    .text('📌 Область', `${CB.fieldRescope}:${defId}`)
    .text('🎯 Для чего', `${CB.fieldRetarget}:${defId}`)
    .row()
    .text('🗑 Удалить поле', `${CB.fieldDelete}:${defId}`)
    .row()
    .text('⬅️ К полям', CB.fields);
}

/** К записям, к вложениям или к тому и другому. */
export function targetPicker(defId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('📄 Записей', `${CB.fieldTarget}:entry`)
    .row()
    .text('📎 Вложений', `${CB.fieldTarget}:attachment`)
    .row()
    .text('Всего сразу', `${CB.fieldTarget}:any`)
    .row()
    .text('⬅️ Назад', `${CB.field}:${defId}`);
}

/** Правка списка значений: тап удаляет, добавление — отдельной кнопкой. */
export function optionsMenu(
  options: Array<{ id: string; value: string }>,
  defId: string,
  page = 0,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const chunk = slice(options, page);

  // Значение и корзина в одном ряду: тап по тексту правит, по корзине —
  // удаляет. Отдельный экран ради двух действий тут был бы лишним шагом.
  for (const option of chunk.items) {
    keyboard
      .text(option.value.slice(0, 30), `${CB.renameOption}:${option.id}`)
      .text('🗑', `${CB.deleteOption}:${option.id}`)
      .row();
  }

  counterPager(keyboard, `${CB.optionsPage}:`, chunk.page, chunk.pages);

  return keyboard
    .text('➕ Добавить', `${CB.fieldAddOption}:${defId}`)
    .row()
    .text('⬅️ К полю', `${CB.field}:${defId}`);
}

/** Справочник тегов — устроен как справочник полей. */
export function tagsMenu(
  tags: Array<{ id: string; name: string; collectionName: string | null; uses: number }>,
  page: number,
  sort: 'asc' | 'desc',
  filterLabel: string,
): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text(sort === 'asc' ? '🔤 А→Я' : '🔤 Я→А', `${CB.tagsSort}:${sort === 'asc' ? 'desc' : 'asc'}`)
    .text(`🔎 ${filterLabel}`, CB.tagsFilter)
    .row();

  const chunk = slice(tags, page);
  for (const tag of chunk.items) {
    const scope = tag.collectionName ? `📌 ${tag.collectionName}` : '🌐';
    const uses = tag.uses > 0 ? ` · ${tag.uses}` : '';
    keyboard.text(`${scope} ${tag.name}${uses}`.slice(0, 40), `${CB.tagCard}:${tag.id}`).row();
  }

  counterPager(keyboard, `${CB.tagsPage}:`, chunk.page, chunk.pages);
  return keyboard.text('➕ Новый тег', CB.tagNew).row().text('⬅️ Меню', CB.menu);
}

export function tagsFilterMenu(collections: Array<{ id: string; name: string; icon: string | null }>): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text('Все теги', `${CB.tagsFilterSet}:all`)
    .row()
    .text('🌐 Только общие', `${CB.tagsFilterSet}:global`)
    .row();

  for (const collection of collections) {
    keyboard.text(`${collection.icon ?? '📁'} ${collection.name}`, `${CB.tagsFilterSet}:${collection.id}`).row();
  }

  return keyboard.text('⬅️ Назад', CB.tags);
}

export function tagCard(tagId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✏️ Имя', `${CB.tagRename}:${tagId}`)
    .text('📌 Раздел', `${CB.tagRescope}:${tagId}`)
    .row()
    .text('🗑 Удалить тег', `${CB.tagDelete}:${tagId}`)
    .row()
    .text('⬅️ К тегам', CB.tags);
}

export function tagScopePicker(collections: Array<{ id: string; name: string; icon: string | null }>): InlineKeyboard {
  const keyboard = new InlineKeyboard().text('🌐 Без раздела', `${CB.tagScope}:global`).row();

  for (const collection of collections) {
    keyboard.text(`📌 ${collection.icon ?? '📁'} ${collection.name}`, `${CB.tagScope}:${collection.id}`).row();
  }

  return keyboard.text('✖️ Отмена', CB.tags);
}

/** Тип задаётся один раз и включает проверку ввода. */
export function typePicker(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Определить автоматически', `${CB.fieldType}:auto`)
    .row()
    .text('Текст', `${CB.fieldType}:text`)
    .text('Число', `${CB.fieldType}:number`)
    .row()
    .text('Дата', `${CB.fieldType}:date`)
    .text('Да-нет', `${CB.fieldType}:bool`)
    .row()
    .text('Тайминг', `${CB.fieldType}:duration`)
    .text('Ссылка', `${CB.fieldType}:url`)
    .row()
    .text('✖️ Отмена', CB.fields);
}

export function scopePicker(
  collections: Array<{ id: string; name: string; icon: string | null }>,
): InlineKeyboard {
  const keyboard = new InlineKeyboard().text('🌐 Везде', `${CB.fieldScope}:global`).row();

  for (const collection of collections) {
    keyboard.text(`📌 ${collection.icon ?? '📁'} ${collection.name}`, `${CB.fieldScope}:${collection.id}`).row();
  }

  return keyboard.text('✖️ Отмена', CB.fields);
}

/** Готовые значения поля вместо ручного ввода. */
export function valuePicker(
  options: Array<{ id: string; value: string }>,
  backTo: string,
  isAttachment: boolean,
  page = 0,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const chunk = slice(options, page);

  chunk.items.forEach((option, index) => {
    keyboard.text(option.value.slice(0, 30), `${CB.pickValue}:${chunk.page * PICKER_PAGE + index}`);
    if (index % 2 === 1) keyboard.row();
  });
  if (chunk.items.length % 2 === 1) keyboard.row();

  counterPager(keyboard, `${CB.valuePage}:`, chunk.page, chunk.pages);

  const back = isAttachment ? `${CB.attachment}:${backTo}` : `${CB.entry}:${backTo}`;
  return keyboard.text('✏️ Своё значение', CB.newValue).row().text('⬅️ Назад', back);
}

/**
 * Выбор тегов из уже заведённых.
 *
 * Отметка показывает текущее состояние, повторный тап снимает — так
 * один экран закрывает и «повесить», и «снять», не заставляя искать
 * отдельный пункт меню.
 */
export function tagPicker(
  tags: Array<{ id: string; name: string }>,
  selected: Set<string>,
  backTo: string,
  isAttachment: boolean,
  page = 0,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const chunk = slice(tags, page);

  // По два в ряд: теги короткие, в один столбец экран растянется зря.
  chunk.items.forEach((tag, index) => {
    const mark = selected.has(tag.id) ? '✅' : '▫️';
    keyboard.text(`${mark} ${tag.name}`.slice(0, 30), `${CB.toggleTag}:${tag.id}`);
    if (index % 2 === 1) keyboard.row();
  });
  if (chunk.items.length % 2 === 1) keyboard.row();

  counterPager(keyboard, `${CB.tagPage}:`, chunk.page, chunk.pages);

  const back = isAttachment ? `${CB.attachment}:${backTo}` : `${CB.entry}:${backTo}`;
  return keyboard.text('✏️ Написать новый', `${CB.newTag}:${backTo}`).row().text('✅ Готово', back);
}

/**
 * Выбор названия поля из уже использованных.
 *
 * В callback_data кладём индекс, а не сам ключ: произвольный текст туда
 * не влезет и требует экранирования. Список лежит в user_state.
 */
export function keyPicker(
  keys: string[],
  backTo: string,
  isAttachment: boolean,
  page = 0,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const chunk = slice(keys, page);

  // Индекс в callback_data — сквозной по всему списку, а не по странице:
  // иначе на второй странице выбралось бы поле с первой.
  chunk.items.forEach((key, index) => {
    keyboard.text(key.slice(0, 30), `${CB.pickKey}:${chunk.page * PICKER_PAGE + index}`);
    if (index % 2 === 1) keyboard.row();
  });
  if (chunk.items.length % 2 === 1) keyboard.row();

  counterPager(keyboard, `${CB.keyPage}:`, chunk.page, chunk.pages);

  const back = isAttachment ? `${CB.attachment}:${backTo}` : `${CB.entry}:${backTo}`;
  return keyboard.text('✏️ Своё название', `${CB.newKey}:${backTo}`).row().text('⬅️ Назад', back);
}

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

/** Сколько пунктов на странице списков выбора. */
export const PICKER_PAGE = 8;

/**
 * Листалка со счётчиком: « 2/3 ».
 *
 * Стрелки закольцованы: с последней страницы «дальше» ведёт на первую.
 * Так кнопки не «умирают» на краях и не приходится объяснять, почему
 * одна из них вдруг перестала работать.
 */
function counterPager(keyboard: InlineKeyboard, prefix: string, page: number, pages: number): InlineKeyboard {
  if (pages <= 1) return keyboard;

  const prev = (page - 1 + pages) % pages;
  const next = (page + 1) % pages;

  keyboard
    .text('«', `${prefix}${prev}`)
    .text(`${page + 1}/${pages}`, CB.noop)
    .text('»', `${prefix}${next}`)
    .row();

  return keyboard;
}

/** Отрезает страницу и сообщает, сколько их всего. */
function slice<T>(items: T[], page: number): { items: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / PICKER_PAGE));
  const safe = Math.min(Math.max(page, 0), pages - 1);
  return { items: items.slice(safe * PICKER_PAGE, (safe + 1) * PICKER_PAGE), page: safe, pages };
}

export function mainMenu(entryCount: number, collectionCount: number): InlineKeyboard {
  return new InlineKeyboard()
    .text('➕ Новая запись', CB.newEntry)
    .row()
    .text(`📁 Разделы (${collectionCount})`, CB.collections)
    .text(`🕘 Недавние (${entryCount})`, `${CB.recent}:0`)
    .row()
    .text('🔍 Поиск', CB.search)
    .row()
    .text('🔧 Поля', CB.fields)
    .text('🏷 Теги', CB.tags);
}

export function collectionsMenu(
  collections: Array<Collection & { entryCount: number }>,
  page = 0,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const chunk = slice(collections, page);

  for (const collection of chunk.items) {
    keyboard
      .text(
        `${collection.icon ?? '📁'} ${collection.name} · ${collection.entryCount}`,
        `${CB.collection}:${collection.id}:0`,
      )
      .row();
  }

  counterPager(keyboard, `${CB.collectionsPage}:`, chunk.page, chunk.pages);
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
    keyboard.text('⚙️ Настройки раздела', `${CB.collectionCard}:${collectionId}`).row();
  }
  return keyboard.text('⬅️ Меню', CB.menu);
}

export function collectionCard(collectionId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✏️ Название', `${CB.collectionRename}:${collectionId}`)
    .text('😀 Значок', `${CB.collectionIcon}:${collectionId}`)
    .row()
    .text('🗑 Удалить раздел', `${CB.deleteCollection}:${collectionId}`)
    .row()
    .text('⬅️ К разделу', `${CB.collection}:${collectionId}:0`);
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
