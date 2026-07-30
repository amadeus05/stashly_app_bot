import { Bot, type Context, InlineKeyboard } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { NoteKeeper } from '../../application/service.js';
import type { NewMedia } from '../d1/entries.js';
import {
  CB,
  attachmentList,
  attachmentMenu,
  cancelOnly,
  cardMenu,
  collectionPicker,
  fieldCard,
  fieldFilterMenu,
  optionsMenu,
  targetPicker,
  tagCard,
  tagScopePicker,
  tagsFilterMenu,
  tagsMenu,
  collectionCard,
  entryCollectionPicker,
  reminderCard,
  remindersMenu,
  whenPicker,
  fieldsMenu,
  scopePicker,
  typePicker,
  valuePicker,
  keyPicker,
  manageMenu,
  tagPicker,
  collectionsMenu,
  entryList,
  hitList,
  mainMenu,
  saveOffer,
} from './keyboards.js';
import { parseQuery, stripCommandPrefix } from '../../domain/query.js';
import type { ScheduleRule } from '../../domain/schedule.js';
import { describeSchedule, needsTimezone, parseSchedule } from '../../domain/schedule.js';
import { parseIntent } from '../../ai/intent.js';
import { transcribe } from '../../ai/transcribe.js';
import { extractMedia, titleForMedia } from './media.js';
import { describeQuery, esc, header, renderAttachment, renderCard, renderHits, renderList } from './render.js';
import { formatValue } from '../../domain/property.js';
import type { PropertyType } from '../../domain/types.js';

const TYPE_NAMES: Record<PropertyType, string> = {
  text: 'текст', number: 'число', date: 'дата', bool: 'да-нет',
  url: 'ссылка', select: 'список', duration: 'тайминг',
};

const HTML = { parse_mode: 'HTML' } as const;

/** Ответ на шаге, где бот ждёт ввода: всегда с видимой отменой. */
const ASK = { parse_mode: 'HTML', reply_markup: cancelOnly() } as const;

export function createBot(
  token: string,
  db: D1Database,
  botInfo?: UserFromGetMe,
  groqToken?: string,
): Bot {
  // Без botInfo grammY делает getMe при каждом холодном старте — то есть
  // почти на каждый апдейт. Значение кладём в переменную BOT_INFO и
  // экономим один сетевой вызов на апдейт.
  const bot = new Bot(token, botInfo ? { botInfo } : {});
  const app = new NoteKeeper(db);

  const userIdOf = (ctx: Context): number | null => ctx.from?.id ?? null;

  /**
   * Показывает экран: правит текущее сообщение либо шлёт новое.
   *
   * Редактировать можно только текстовое сообщение. Если кнопку нажали
   * под фото или голосовым, editMessageText падает — там нет текста,
   * только подпись, — и экран просто не меняется. Поэтому проверяем,
   * есть ли что править, а на «message is not modified» не реагируем:
   * содержимое уже такое, какое нужно.
   */
  async function screen(
    ctx: Context,
    text: string,
    keyboard: InlineKeyboard,
    edit: boolean,
  ): Promise<void> {
    const message = ctx.callbackQuery?.message;
    const hasText = typeof (message as { text?: unknown } | undefined)?.text === 'string';

    if (edit && hasText) {
      try {
        await ctx.editMessageText(text, { ...HTML, reply_markup: keyboard });
        return;
      } catch (error) {
        if (String(error).includes('not modified')) return;
        // Любая другая причина — падать нельзя, показываем новым сообщением.
      }
    }

    await ctx.reply(text, { ...HTML, reply_markup: keyboard });
  }

  /** Все ветки заканчиваются главным меню — из любого места есть путь назад. */
  async function showMenu(ctx: Context, userId: number, edit = false): Promise<void> {
    const [entryCount, collections] = await Promise.all([
      app.entries.countEntries(userId),
      app.collections.list(userId),
    ]);

    const text =
      header('Stashly') +
      `\nЗаписей: <b>${entryCount}</b> · Разделов: <b>${collections.length}</b>\n\n` +
      `Пришлите текст или медиа — предложу сохранить. Или просто напишите, что ищете.`;
    const keyboard = mainMenu(entryCount, collections.length);

    await screen(ctx, text, keyboard, edit);
  }

  async function showCard(ctx: Context, userId: number, entryId: string, edit = false): Promise<void> {
    const card = await app.card(userId, entryId);
    if (!card) {
      await ctx.reply('Запись не найдена — возможно, она удалена.');
      return;
    }

    const text = renderCard(card);
    const keyboard = cardMenu(card);

    await screen(ctx, text, keyboard, edit);
  }

  /**
   * Отправляет вложение тем же типом, каким его прислали.
   *
   * Файл лежит у Telegram — отдаём file_id обратно. video_note и sticker
   * подписи не поддерживают, для них шлём описание отдельным сообщением.
   */
  async function sendAttachment(
    ctx: Context,
    detail: NonNullable<Awaited<ReturnType<typeof app.entries.getAttachment>>>,
    index: number,
  ): Promise<void> {
    const caption = renderAttachment(detail, index);
    const hasItems = detail.properties.length + detail.notes.length > 0;
    const keyboard = attachmentMenu(detail.object.id, detail.object.parentId ?? '', hasItems);
    const fileId = detail.attachment.fileId;
    const options = { caption, parse_mode: 'HTML', reply_markup: keyboard } as const;

    switch (detail.attachment.mediaType) {
      case 'photo':
        await ctx.replyWithPhoto(fileId, options);
        return;
      case 'video':
        await ctx.replyWithVideo(fileId, options);
        return;
      case 'animation':
        await ctx.replyWithAnimation(fileId, options);
        return;
      case 'voice':
        await ctx.replyWithVoice(fileId, options);
        return;
      case 'audio':
        await ctx.replyWithAudio(fileId, options);
        return;
      case 'document':
        await ctx.replyWithDocument(fileId, options);
        return;
      case 'video_note':
        await ctx.replyWithVideoNote(fileId);
        await ctx.reply(caption, { ...HTML, reply_markup: keyboard });
        return;
      case 'sticker':
        await ctx.replyWithSticker(fileId);
        await ctx.reply(caption, { ...HTML, reply_markup: keyboard });
        return;
    }
  }

  /**
   * Возвращает экран того объекта, который правили.
   *
   * Свойства и заметки можно вешать и на запись, и на вложение, поэтому
   * после правки нельзя всегда показывать карточку записи: для вложения
   * она не найдётся, и пользователь получит «Запись не найдена», хотя
   * его правка сохранилась.
   */
  async function showObject(ctx: Context, userId: number, objectId: string): Promise<void> {
    const object = await app.entries.findById(userId, objectId);
    if (!object) {
      await ctx.reply('Объект не найден — возможно, он удалён.');
      return;
    }

    if (object.type === 'entry') {
      await showCard(ctx, userId, objectId);
      return;
    }

    // Заметка сама по себе экрана не имеет — показываем её родителя.
    const targetId = object.type === 'note' ? object.parentId : objectId;
    if (!targetId) {
      await showMenu(ctx, userId);
      return;
    }

    const detail = await app.entries.getAttachment(userId, targetId);
    if (!detail) {
      await showCard(ctx, userId, targetId);
      return;
    }

    const card = detail.object.parentId ? await app.card(userId, detail.object.parentId) : null;
    const index = card ? card.attachments.findIndex((a) => a.object.id === targetId) + 1 : 1;
    await sendAttachment(ctx, detail, index);
  }

  /**
   * Сколько подсказок вытягиваем. На экран идёт восемь, остальное
   * листается — запрашивать по странице не стоит, счётчик «2/3» всё
   * равно требует знать общее количество.
   */
  const SUGGEST_LIMIT = 200;

  /** Экран выбора тегов: уже заведённые с отметками + «написать новый». */
  async function showTagPicker(
    ctx: Context,
    userId: number,
    objectId: string,
    edit: boolean,
    page = 0,
  ): Promise<void> {
    const object = await app.entries.findById(userId, objectId);
    if (!object) return;

    const collectionId = await app.entries.collectionIdOf(objectId);
    const [tags, selected] = await Promise.all([
      app.entries.suggestTags(userId, collectionId, SUGGEST_LIMIT),
      app.entries.tagIdsOf(objectId),
    ]);

    // Первый тег брать неоткуда — сразу просим ввести.
    if (tags.length === 0) {
      await app.state.set(userId, 'tag:name', { objectId });
      await ctx.reply('Тегов пока нет. Введите первый — можно несколько через запятую.', ASK);
      return;
    }

    const chosen = new Set(selected);
    const dialog = await app.state.get(userId);

    /**
     * Порядок фиксируем при открытии экрана: отмеченные сверху.
     *
     * Пересортировывать на каждый тап нельзя — кнопка уезжала бы из-под
     * пальца, и следующее нажатие попадало бы по соседнему тегу.
     */
    let order: string[] = [];
    if (dialog.payload.target === objectId && dialog.payload.order) {
      try {
        order = JSON.parse(dialog.payload.order) as string[];
      } catch {
        order = [];
      }
    }

    // Список тегов изменился (завели новый) — порядок пересобираем.
    if (order.length !== tags.length) {
      order = [
        ...tags.filter((tag) => chosen.has(tag.id)).map((tag) => tag.id),
        ...tags.filter((tag) => !chosen.has(tag.id)).map((tag) => tag.id),
      ];
    }

    const position = new Map(order.map((id, index) => [id, index]));
    const ordered = [...tags].sort(
      (a, b) => (position.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (position.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );

    await app.state.set(userId, 'idle', {
      target: objectId,
      page: String(page),
      order: JSON.stringify(order),
    });

    await screen(
      ctx,
      header('Теги') + '\nНажмите, чтобы поставить или снять. Отмеченные — сверху.',
      tagPicker(ordered, chosen, objectId, object.type === 'attachment', page),
      edit,
    );
  }

  /**
   * Спрашивает значение поля.
   *
   * У поля со списком показываем кнопки, иначе просим ввести. Тип поля
   * везём в состоянии, чтобы проверить ввод и не молчать при промахе.
   */
  async function askValue(
    ctx: Context,
    userId: number,
    objectId: string,
    key: string,
    defId: string | null,
    page = 0,
  ): Promise<void> {
    const object = await app.entries.findById(userId, objectId);
    const options = defId ? await app.fields.options(defId) : [];

    if (options.length > 0) {
      await app.state.set(userId, 'idle', {
        objectId,
        key,
        defId: defId ?? '',
        values: JSON.stringify(options.map((option) => option.value)),
      });

      await screen(
        ctx,
        header(key) + '\nВыберите значение или введите своё.',
        valuePicker(options, objectId, object?.type === 'attachment', page),
        true,
      );
      return;
    }

    await app.state.set(userId, 'property:value', { objectId, key, defId: defId ?? '' });
    await ctx.reply(`Значение для «${esc(key)}»?`, ASK);
  }

  /** Справочник полей: сортировка, фильтр и листалка запоминаются. */
  async function showFields(ctx: Context, userId: number, page: number, edit: boolean): Promise<void> {
    const prefs = await app.fields.preferences(userId);
    const [defs, collections] = await Promise.all([
      app.fields.list(userId, prefs.filter, prefs.sort),
      app.collections.list(userId),
    ]);

    const label =
      prefs.filter === null
        ? 'Все'
        : prefs.filter === 'global'
          ? 'Общие'
          : (collections.find((collection) => collection.id === prefs.filter)?.name ?? 'Все');

    const text =
      defs.length === 0
        ? header('Поля') + '\nСправочник пуст. Заведите поле — и его не придётся вводить каждый раз.'
        : header('Поля') + '\n🌐 общие · 📌 привязанные к разделу';

    await screen(ctx, text, fieldsMenu(defs, page, prefs.sort, label), edit);
  }

  /** Карточка поля: тип, область и готовые значения. */
  async function showField(ctx: Context, userId: number, defId: string, edit: boolean): Promise<void> {
    const def = await app.fields.find(userId, defId);
    if (!def) {
      await ctx.reply('Поле не найдено.');
      return;
    }

    const options = await app.fields.options(defId);
    const lines = [
      header(def.key),
      `├ <i>тип: ${def.type ? TYPE_NAMES[def.type] : 'определится сам'}</i>`,
      `├ <i>доступно: ${def.collectionName ? `📌 ${esc(def.collectionName)}` : '🌐 везде'}</i>`,
      `└ <i>для: ${def.target === 'attachment' ? 'вложений' : def.target === 'any' ? 'всего' : 'записей'}</i>`,
    ];

    if (options.length > 0) {
      lines.push('', '<b>Значения</b>', options.map((option) => esc(option.value)).join(' · '));
    } else {
      lines.push('', '<i>Значений нет — вводятся вручную.</i>');
    }

    await screen(ctx, lines.join('\n'), fieldCard(defId, options.length > 0), edit);
  }

  /** Справочник тегов: устроен как справочник полей. */
  async function showTags(ctx: Context, userId: number, page: number, edit: boolean): Promise<void> {
    const prefs = await app.tagBook.preferences(userId);
    const [tags, collections] = await Promise.all([
      app.tagBook.list(userId, prefs.filter, prefs.sort),
      app.collections.list(userId),
    ]);

    const label =
      prefs.filter === null
        ? 'Все'
        : prefs.filter === 'global'
          ? 'Общие'
          : (collections.find((collection) => collection.id === prefs.filter)?.name ?? 'Все');

    const text =
      tags.length === 0
        ? header('Теги') + '\nТегов пока нет. Заведите — и они появятся в выборе у записей.'
        : header('Теги') + '\n🌐 общие · 📌 привязанные к разделу · число — сколько записей';

    await screen(ctx, text, tagsMenu(tags, page, prefs.sort, label), edit);
  }

  async function showTagCard(ctx: Context, userId: number, tagId: string, edit: boolean): Promise<void> {
    const tag = await app.tagBook.find(userId, tagId);
    if (!tag) {
      await ctx.reply('Тег не найден.');
      return;
    }

    const lines = [
      header(`#${tag.name}`),
      `├ <i>раздел: ${tag.collectionName ? `📌 ${esc(tag.collectionName)}` : '🌐 без раздела'}</i>`,
      `└ <i>записей: ${tag.uses}</i>`,
    ];

    if (tag.uses > 0) {
      lines.push('', `<i>Удаление снимет тег со всех ${tag.uses} записей.</i>`);
    }

    await screen(ctx, lines.join('\n'), tagCard(tagId), edit);
  }

  /** Правка списка значений: тап по значению удаляет его. */
  async function showOptions(ctx: Context, userId: number, defId: string, page: number): Promise<void> {
    const def = await app.fields.find(userId, defId);
    if (!def) return;

    // Поле держим в состоянии — листалка значений знает только номер страницы.
    await app.state.set(userId, 'idle', { defId });

    const options = await app.fields.options(defId);
    const text =
      options.length === 0
        ? header(def.key) + '\nЗначений не осталось — вводятся вручную.'
        : header(def.key) + '\nНажмите на значение, чтобы переименовать. Корзина — удалить.';

    await screen(ctx, text, optionsMenu(options, defId, page), true);
  }

  /** Экран выбора названия поля из уже использованных. */
  async function showKeyPicker(
    ctx: Context,
    userId: number,
    objectId: string,
    edit: boolean,
    page = 0,
  ): Promise<void> {
    const object = await app.entries.findById(userId, objectId);
    if (!object) return;

    const collectionId = await app.entries.collectionIdOf(objectId);
    const [history, defs] = await Promise.all([
      app.entries.suggestKeys(userId, object.type, collectionId, SUGGEST_LIMIT),
      app.fieldsFor(userId, objectId, object.type),
    ]);

    // Справочник идёт первым, история — следом и без повторов: поле,
    // заведённое осознанно, важнее случайно совпавшего из прошлого.
    const fromDict = defs.map((def) => `${def.collectionId ? '📌' : '🌐'} ${def.key}`);
    const taken = new Set(defs.map((def) => def.key.toLowerCase()));
    const keys = [...fromDict, ...history.filter((key) => !taken.has(key.toLowerCase()))];

    if (keys.length === 0) {
      await app.state.set(userId, 'property:key', { objectId });
      await ctx.reply(
        'Название поля?\n\nНапример: <code>Озвучка</code>, <code>Оценка</code>, <code>Начал</code>',
        ASK,
      );
      return;
    }

    // Рядом с подписями храним, что за ними стоит: у поля справочника
    // есть тип и готовые значения, у подсказки из истории — только имя.
    const picks = [
      ...defs.map((def) => ({ key: def.key, defId: def.id })),
      ...history.filter((key) => !taken.has(key.toLowerCase())).map((key) => ({ key, defId: null })),
    ];

    // Список кладём в состояние: в callback_data влезает только индекс.
    await app.state.set(userId, 'idle', {
      target: objectId,
      keys: JSON.stringify(keys),
      picks: JSON.stringify(picks),
    });

    await screen(
      ctx,
      header('Название поля') + '\nВыберите из тех, что уже используете, или задайте своё.',
      keyPicker(keys, objectId, object.type === 'attachment', page),
      edit,
    );
  }

  /**
   * Экран удаления полей, тегов и заметок.
   *
   * Объект держим в user_state: два UUID в 64 байта callback_data не влезают.
   */
  async function showManage(ctx: Context, userId: number, objectId: string, edit: boolean): Promise<void> {
    const items = await app.entries.getRemovable(userId, objectId);
    if (!items) {
      await ctx.reply('Объект не найден.');
      return;
    }

    await app.state.set(userId, 'idle', { manage: objectId });

    const total = items.properties.length + items.tags.length + items.notes.length;
    const text =
      total === 0
        ? header('Убрать лишнее') + '\nНечего убирать.'
        : header('Убрать лишнее') + '\nНажмите, чтобы удалить. Сразу и без подтверждения.';

    const keyboard = manageMenu({
      properties: items.properties.map((p) => ({ id: p.id, key: p.key, value: formatValue(p) })),
      tags: items.tags,
      notes: items.notes.map((n) => ({ id: n.id, body: n.body })),
      backTo: objectId,
      isAttachment: items.object.type === 'attachment',
    });

    await screen(ctx, text, keyboard, edit);
  }

  /** В каких разделах лежит запись: тап переключает. */
  async function showEntryCollections(
    ctx: Context,
    userId: number,
    entryId: string,
    page: number,
  ): Promise<void> {
    const [all, current] = await Promise.all([
      app.collections.list(userId),
      app.collections.listForObject(entryId),
    ]);

    await app.state.set(userId, 'idle', { target: entryId, page: String(page) });

    await screen(
      ctx,
      `${header('Разделы записи')}\nЗапись может лежать в нескольких сразу.`,
      entryCollectionPicker(all, new Set(current.map((item) => item.id)), entryId, page),
      true,
    );
  }

  /** Показ результатов + запоминание запроса: в callback_data он не влезет. */
  async function showSearch(ctx: Context, userId: number, query: string, page: number, edit = false): Promise<void> {
    const hits = await app.find(userId, query, page);
    await app.state.set(userId, 'idle', { lastQuery: query });

    // Где именно совпало — иначе из одной кнопки непонятно, почему
    // запись вообще в выдаче.
    const sites = await app.sitesFor(userId, hits.items, parseQuery(query));
    const text = renderHits(hits, query, sites);
    const keyboard = hits.items.length > 0 ? hitList(hits) : saveOffer();

    // Ничего не нашли — значит пользователь, скорее всего, хочет это
    // сохранить. Запоминаем текст, чтобы не заставлять вводить заново.
    if (hits.items.length === 0) {
      await app.state.set(userId, 'entry:collection', { title: query });
    }

    await screen(ctx, text, keyboard, edit);
  }

  /** Раздел выбран — материализуем то, что пользователь прислал ранее. */
  async function commitPending(ctx: Context, userId: number, collectionId: string): Promise<void> {
    const dialog = await app.state.get(userId);
    const title = dialog.payload.title;

    if (!title) {
      await app.state.clear(userId);
      await ctx.reply('Мастер устарел — начните заново.');
      await showMenu(ctx, userId);
      return;
    }

    let media: NewMedia | null = null;
    if (dialog.payload.media) {
      try {
        media = JSON.parse(dialog.payload.media) as NewMedia;
      } catch {
        media = null;
      }
    }

    const entryId = await app.saveIncoming(userId, collectionId, title, media, dialog.payload.speech);
    await app.state.clear(userId);
    await showCard(ctx, userId, entryId);
  }


  // ---------------------------------------------------------------------
  // Напоминания
  // ---------------------------------------------------------------------

  /** Часовой пояс нужен всему, где есть «в 9 утра». Спрашиваем один раз. */
  async function ensureTimezone(ctx: Context, userId: number, pending: Record<string, string>): Promise<boolean> {
    const offset = await app.reminders.timezone(userId);
    if (offset !== null) return true;

    await app.state.set(userId, 'timezone', pending);
    await ctx.reply(
      'Сначала часовой пояс — иначе «в 9 утра» будет лотереей.\n\n' +
        'Напишите смещение от UTC: <code>+3</code>, <code>+2</code>, <code>-5</code>.\n' +
        'В Киеве и Москве это <code>+3</code>.',
      ASK,
    );
    return false;
  }

  async function showReminders(ctx: Context, userId: number, page: number, edit: boolean): Promise<void> {
    const [list, offset] = await Promise.all([
      app.reminders.list(userId),
      app.reminders.timezone(userId),
    ]);

    const items = list.map((item) => ({
      id: item.id,
      active: item.active,
      label: `${item.entryTitle ?? item.text ?? 'без описания'} · ${describeSchedule(item.nextAt, item.rule, offset ?? 0)}`,
    }));

    const text =
      items.length === 0
        ? `${header('Напоминания')}\nПока пусто. Откройте запись и нажмите «⏰ Напомнить».`
        : `${header('Напоминания')}\n⏰ активные · ⏸ на паузе`;

    await screen(ctx, text, remindersMenu(items, page), edit);
  }

  async function showReminder(ctx: Context, userId: number, id: string, edit: boolean): Promise<void> {
    const [reminder, offset] = await Promise.all([
      app.reminders.find(userId, id),
      app.reminders.timezone(userId),
    ]);

    if (!reminder) {
      await ctx.reply('Напоминание не найдено.');
      return;
    }

    const lines = [
      header(reminder.entryTitle ?? reminder.text ?? 'Напоминание'),
      `├ <i>${describeSchedule(reminder.nextAt, reminder.rule, offset ?? 0)}</i>`,
      `└ <i>${reminder.active ? 'активно' : 'на паузе'}</i>`,
    ];

    if (reminder.text && reminder.entryTitle) lines.push('', `💬 ${esc(reminder.text)}`);

    await screen(ctx, lines.join('\n'), reminderCard(id, reminder.active, reminder.objectId), edit);
  }

  /** Создаёт напоминание и показывает, как бот понял время. */
  async function createReminder(
    ctx: Context,
    userId: number,
    objectId: string | null,
    at: number,
    rule: ScheduleRule,
  ): Promise<void> {
    const offset = (await app.reminders.timezone(userId)) ?? 0;
    const id = await app.reminders.create(userId, objectId, null, new Date(at).toISOString(), rule);

    await app.state.clear(userId);
    await ctx.reply(
      `⏰ Напомню: <b>${esc(describeSchedule(new Date(at).toISOString(), rule, offset))}</b>`,
      { ...HTML, reply_markup: reminderCard(id, true, objectId) },
    );
  }

  // ---------------------------------------------------------------------
  // Команды
  // ---------------------------------------------------------------------

  bot.command('start', async (ctx) => {
    const userId = userIdOf(ctx);
    if (!userId) return;

    // Регистрируем команды прямо отсюда: иначе кнопка «/» рядом с полем
    // ввода не появится, а это единственное место, где пользователь
    // видит, что бот вообще умеет. /start случается редко, лишний вызов
    // Bot API тут не жалко.
    try {
      await ctx.api.setMyCommands([
        { command: 'start', description: 'Главное меню' },
        { command: 'find', description: 'Поиск: /find небеса или /find tag:любимое' },
        { command: 'help', description: 'Как искать и сохранять' },
        { command: 'cancel', description: 'Отменить текущее действие' },
      ]);
    } catch {
      // Не смогли — не повод ломать /start.
    }

    await app.users.ensure(userId, ctx.from?.username ?? null, ctx.from?.first_name ?? null);
    await app.state.clear(userId);
    await showMenu(ctx, userId);
  });

  bot.command(['find', 'search'], async (ctx) => {
    const userId = userIdOf(ctx);
    if (!userId) return;

    const query = ctx.match.trim();
    if (!query) {
      await app.state.set(userId, 'search:query');
      await ctx.reply(
        'Что ищем?\n\nМожно с фильтрами: <code>раздел:донхуа оценка&gt;=9 tag:любимое has:фото</code>',
        ASK,
      );
      return;
    }

    await showSearch(ctx, userId, query, 0);
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      '<b>Как пользоваться</b>\n\n' +
        '<b>Сохранить.</b> Перешлите боту фото, голосовое, видео или текст — он спросит раздел, и запись готова.\n\n' +
        '<b>Найти.</b> Просто напишите, что ищете. Поиск смотрит везде: в названиях, полях, тегах, заметках и подписях к медиа — в том числе у вложений.\n\n' +
        '<b>Фильтры</b> можно смешивать со словами:\n' +
        '<code>раздел:донхуа</code> — только в разделе\n' +
        '<code>tag:любимое</code> — по тегу\n' +
        '<code>оценка&gt;=9</code> — по числовому полю\n' +
        '<code>озвучка:anistar</code> — по значению поля\n' +
        '<code>has:фото</code> — где есть медиа\n\n' +
        'Например: <code>раздел:донхуа оценка&gt;=9 tag:любимое небеса</code>\n\n' +
        '<b>Поля</b> печатайте как удобно — тип определится сам: <code>9.8</code> число, ' +
        '<code>01.07.2026</code> дата, <code>12:34</code> тайминг, <code>да</code> флажок.',
      HTML,
    );
  });

  bot.command('tz', async (ctx) => {
    const userId = userIdOf(ctx);
    if (!userId) return;

    const offset = await app.reminders.timezone(userId);
    await app.state.set(userId, 'timezone');
    await ctx.reply(
      `Часовой пояс${offset !== null ? ` сейчас: UTC${offset >= 0 ? '+' : ''}${offset / 60}` : ' не задан'}.

` +
        'Напишите смещение от UTC: <code>+3</code>, <code>-5</code>, <code>+5:30</code>.',
      ASK,
    );
  });

  bot.command('cancel', async (ctx) => {
    const userId = userIdOf(ctx);
    if (!userId) return;

    await app.state.clear(userId);
    await ctx.reply('Отменено.');
    await showMenu(ctx, userId);
  });

  // ---------------------------------------------------------------------
  // Кнопки
  // ---------------------------------------------------------------------

  bot.on('callback_query:data', async (ctx) => {
    const userId = userIdOf(ctx);
    if (!userId) return;

    const [action, arg, extra] = ctx.callbackQuery.data.split(':');
    // Ответить нужно всегда, иначе на кнопке крутятся часики.
    await ctx.answerCallbackQuery();

    switch (action) {
      case CB.menu:
        await app.state.clear(userId);
        await showMenu(ctx, userId, true);
        return;

      case CB.collections: {
        const collections = await app.collections.list(userId);
        await screen(ctx, header('Разделы'), collectionsMenu(collections), true);
        return;
      }

      case CB.newCollection: {
        // Payload сохраняем: раздел может создаваться посреди сохранения
        // присланного медиа, и терять его нельзя.
        const dialog = await app.state.get(userId);
        await app.state.set(userId, 'collection:name', dialog.payload);
        await ctx.reply('Название раздела?\n\nМожно с эмодзи в начале: <code>📺 Донхуа</code>', ASK);
        return;
      }

      case CB.savePending: {
        const collections = await app.collections.list(userId);
        if (collections.length === 0) {
          const dialog = await app.state.get(userId);
          await app.state.set(userId, 'collection:name', dialog.payload);
          await ctx.reply('Сначала создайте раздел. Как его назвать?\n\nНапример: <code>📺 Донхуа</code>', ASK);
          return;
        }
        await ctx.reply('В какой раздел?', { reply_markup: collectionPicker(collections) });
        return;
      }

      case CB.newEntry: {
        const collections = await app.collections.list(userId);
        if (collections.length === 0) {
          // Пользователь просил запись, а не раздел. Помечаем намерение,
          // чтобы после создания раздела вернуться к нему, а не в меню.
          await app.state.set(userId, 'collection:name', { then: 'entry' });
          await ctx.reply('Сначала создайте раздел. Как его назвать?\n\nНапример: <code>📺 Донхуа</code>', ASK);
          return;
        }
        await app.state.set(userId, 'entry:title');
        await ctx.reply('Название записи?', ASK);
        return;
      }

      case CB.recent: {
        const page = await app.recent(userId, Number(arg ?? '0'));
        await screen(ctx, renderList(page, 'Недавние'), entryList(page, `${CB.recent}:`), true);
        return;
      }

      case CB.searchPage: {
        const dialog = await app.state.get(userId);
        const query = dialog.payload.lastQuery;
        if (!query) {
          await ctx.reply('Запрос утерян — повторите поиск.');
          return;
        }
        await showSearch(ctx, userId, query, Number(arg ?? '0'), true);
        return;
      }

      case CB.search:
        await app.state.set(userId, 'search:query');
        await ctx.reply(
          'Что ищем?\n\nСвободный текст ищет везде — в названиях, свойствах, заметках и подписях к медиа.\n' +
            'Фильтры: <code>раздел:донхуа</code> <code>оценка&gt;=9</code> <code>tag:любимое</code> <code>has:фото</code>',
          ASK,
        );
        return;

      case CB.collection: {
        if (!arg) return;

        // Один префикс обслуживает два сценария: выбор раздела для
        // сохранения и просмотр его содержимого с листанием.
        if (extra === 'pick') {
          await commitPending(ctx, userId, arg);
          return;
        }

        const page = await app.byCollection(userId, arg, Number(extra ?? '0'));
        await screen(ctx, renderList(page, 'Раздел'), entryList(page, `${CB.collection}:${arg}:`, arg), true);
        return;
      }

      case CB.deleteCollection: {
        if (!arg) return;

        const count = await app.collections.countEntries(userId, arg);
        if (count > 0 && extra !== 'force') {
          // Не сносим чужие записи молча: сначала показываем цену решения.
          await screen(
            ctx,
            `В разделе <b>${count}</b> записей. Они не удалятся — останутся в «Недавних» и в поиске.

Удалить раздел?`,
            new InlineKeyboard()
              .text('🗑 Да, удалить', `${CB.deleteCollection}:${arg}:force`)
              .row()
              .text('⬅️ Отмена', CB.collections),
            true,
          );
          return;
        }

        await app.deleteCollection(userId, arg);
        const collections = await app.collections.list(userId);
        await screen(ctx, header('Разделы') + '\nРаздел удалён.', collectionsMenu(collections), true);
        return;
      }

      case CB.entry:
        if (arg) await showCard(ctx, userId, arg, true);
        return;

      case CB.attachments: {
        if (!arg) return;
        const card = await app.card(userId, arg);
        if (!card) return;

        await screen(ctx, header(`Вложения — ${card.attachments.length}`), attachmentList(card), true);
        return;
      }

      case CB.attachment: {
        if (!arg) return;
        const detail = await app.entries.getAttachment(userId, arg);
        if (!detail) {
          await ctx.reply('Вложение не найдено.');
          return;
        }

        const card = detail.object.parentId ? await app.card(userId, detail.object.parentId) : null;
        const index = card ? card.attachments.findIndex((a) => a.object.id === arg) + 1 : 1;
        await sendAttachment(ctx, detail, index);
        return;
      }

      case CB.manage:
        if (arg) await showManage(ctx, userId, arg, true);
        return;

      case CB.editProperty: {
        if (!arg) return;
        const property = await app.entries.findProperty(userId, arg);
        if (!property) {
          await ctx.reply('Поле не найдено.');
          return;
        }

        // Ищем поле в справочнике по имени: если оно там есть, правка
        // пойдёт через список значений и с проверкой типа.
        const object = await app.entries.findById(userId, property.objectId);
        const defs = object ? await app.fieldsFor(userId, property.objectId, object.type) : [];
        const def = defs.find((item) => item.key.toLowerCase() === property.key.toLowerCase());

        await askValue(ctx, userId, property.objectId, property.key, def?.id ?? null);
        return;
      }

      case CB.editNote: {
        if (!arg) return;
        await app.state.set(userId, 'note:edit', { noteId: arg });
        await ctx.reply('Новый текст заметки?', ASK);
        return;
      }

      case CB.deleteProperty: {
        if (!arg) return;
        const objectId = await app.deleteProperty(userId, arg);
        if (objectId) await showManage(ctx, userId, objectId, true);
        return;
      }

      case CB.deleteTag: {
        if (!arg) return;
        const dialog = await app.state.get(userId);
        const objectId = dialog.payload.manage;
        if (!objectId) {
          await ctx.reply('Экран устарел — откройте запись заново.');
          return;
        }
        await app.removeTag(userId, objectId, arg);
        await showManage(ctx, userId, objectId, true);
        return;
      }

      case CB.deleteNote: {
        if (!arg) return;
        const note = await app.entries.findById(userId, arg);
        const parentId = note?.parentId ?? null;

        await app.deleteObject(userId, arg);

        if (parentId) await showManage(ctx, userId, parentId, true);
        return;
      }

      case CB.deleteObject: {
        if (!arg) return;
        const detail = await app.entries.getAttachment(userId, arg);
        const parentId = detail?.object.parentId ?? null;

        await app.entries.delete(userId, arg);
        await app.search.flushDirty();

        if (parentId) {
          await showCard(ctx, userId, parentId);
        } else {
          await showMenu(ctx, userId);
        }
        return;
      }

      case CB.addProperty:
        if (arg) await showKeyPicker(ctx, userId, arg, true);
        return;

      case CB.addTag:
        if (arg) await showTagPicker(ctx, userId, arg, true);
        return;

      case CB.entryCollections: {
        if (!arg) return;
        await showEntryCollections(ctx, userId, arg, Number(extra ?? '0'));
        return;
      }

      case CB.toggleCollection: {
        if (!arg) return;
        const dialog = await app.state.get(userId);
        const entryId = dialog.payload.target;
        if (!entryId) {
          await ctx.reply('Экран устарел — откройте запись заново.');
          return;
        }

        const current = await app.collections.listForObject(entryId);
        const inside = current.some((item) => item.id === arg);

        if (inside) {
          const removed = await app.collections.removeFromObject(userId, entryId, arg);
          if (!removed) {
            await ctx.answerCallbackQuery({ text: 'Запись должна остаться хотя бы в одном разделе' });
            return;
          }
        } else {
          await app.collections.addToObject(userId, entryId, arg);
        }

        await app.search.flushDirty();
        await showEntryCollections(ctx, userId, entryId, Number(dialog.payload.page ?? '0'));
        return;
      }

      case CB.remind: {
        if (!arg) return;
        await screen(ctx, header('Когда напомнить'), whenPicker(arg), true);
        return;
      }

      case CB.remindIn: {
        // arg — сколько минут либо именованный момент; extra — запись.
        if (!arg || !extra) return;

        const minutes = Number(arg);
        if (Number.isFinite(minutes)) {
          await createReminder(ctx, userId, extra, Date.now() + minutes * 60_000, { kind: 'once' });
          return;
        }

        // «Вечером» и «Завтра» зависят от часового пояса.
        if (!(await ensureTimezone(ctx, userId, { objectId: extra, phrase: arg }))) return;

        const offset = (await app.reminders.timezone(userId)) ?? 0;
        const schedule = parseSchedule(arg === 'evening' ? 'вечером' : 'завтра', Date.now(), offset);
        if (schedule) await createReminder(ctx, userId, extra, schedule.at, schedule.rule);
        return;
      }

      case CB.remindCustom: {
        if (!arg) return;
        await app.state.set(userId, 'reminder:when', { objectId: arg });
        await ctx.reply(
          'Когда напомнить? Напишите как удобно:\n\n' +
            '<code>через 40 минут</code> · <code>завтра в 9</code>\n' +
            '<code>05.08 в 18:30</code> · <code>каждые 3 дня</code>',
          ASK,
        );
        return;
      }

      case CB.reminders:
        await showReminders(ctx, userId, Number(arg ?? '0'), true);
        return;

      case CB.reminder:
        if (arg) await showReminder(ctx, userId, arg, true);
        return;

      case CB.reminderPause: {
        if (!arg) return;
        const reminder = await app.reminders.find(userId, arg);
        if (!reminder) return;

        await app.reminders.setActive(userId, arg, !reminder.active);
        await showReminder(ctx, userId, arg, true);
        return;
      }

      case CB.reminderDelete:
        if (!arg) return;
        await app.reminders.delete(userId, arg);
        await showReminders(ctx, userId, 0, true);
        return;

      case CB.reminderText:
        if (!arg) return;
        await app.state.set(userId, 'reminder:text', { reminderId: arg });
        await ctx.reply('Что приписать к напоминанию?', ASK);
        return;

      case CB.reminderWhen:
        if (!arg) return;
        await app.state.set(userId, 'reminder:when', { reminderId: arg });
        await ctx.reply('Когда напоминать? Например: <code>завтра в 9</code>', ASK);
        return;

      // Кнопки под самим уведомлением.
      case CB.reminderSnooze: {
        if (!arg) return;
        await app.reminders.reschedule(userId, arg, new Date(Date.now() + 60 * 60_000).toISOString());
        await ctx.reply('😴 Напомню через час.');
        return;
      }

      case CB.reminderOff:
        if (!arg) return;
        await app.reminders.setActive(userId, arg, false);
        await ctx.reply('Больше не напомню. Включить можно в «⏰ Напоминания».');
        return;

      case CB.noop:
        return;


      case CB.fields:
        await showFields(ctx, userId, 0, true);
        return;

      case CB.collectionCard: {
        if (!arg) return;
        const collection = await app.collections.find(userId, arg);
        if (!collection) return;

        const count = await app.collections.countEntries(userId, arg);
        await screen(
          ctx,
          header(`${collection.icon ?? '📁'} ${collection.name}`) + `\n<i>записей: ${count}</i>`,
          collectionCard(arg),
          true,
        );
        return;
      }

      case CB.collectionRename:
        if (!arg) return;
        await app.state.set(userId, 'collection:rename', { collectionId: arg });
        await ctx.reply('Новое название раздела?', ASK);
        return;

      case CB.collectionIcon:
        if (!arg) return;
        await app.state.set(userId, 'collection:icon', { collectionId: arg });
        await ctx.reply('Пришлите эмодзи для раздела.\n\nИли напишите <code>убрать</code>, чтобы вернуть стандартный.', ASK);
        return;

      case CB.tags:
        await showTags(ctx, userId, 0, true);
        return;

      case CB.tagsPage:
        await showTags(ctx, userId, Number(arg ?? '0'), true);
        return;

      case CB.tagsSort: {
        const prefs = await app.tagBook.preferences(userId);
        await app.tagBook.setPreferences(userId, arg === 'desc' ? 'desc' : 'asc', prefs.filter);
        await showTags(ctx, userId, 0, true);
        return;
      }

      case CB.tagsFilter: {
        const collections = await app.collections.list(userId);
        await screen(ctx, header('Показывать'), tagsFilterMenu(collections), true);
        return;
      }

      case CB.tagsFilterSet: {
        const prefs = await app.tagBook.preferences(userId);
        await app.tagBook.setPreferences(userId, prefs.sort, arg === 'all' ? null : (arg ?? null));
        await showTags(ctx, userId, 0, true);
        return;
      }

      case CB.tagCard:
        if (arg) await showTagCard(ctx, userId, arg, true);
        return;

      case CB.tagNew:
        await app.state.set(userId, 'tag:new');
        await ctx.reply('Название тега?', ASK);
        return;

      case CB.tagRename:
        if (!arg) return;
        await app.state.set(userId, 'tag:rename', { tagId: arg });
        await ctx.reply('Новое название тега?', ASK);
        return;

      case CB.tagRescope: {
        if (!arg) return;
        const collections = await app.collections.list(userId);
        await app.state.set(userId, 'idle', { tagId: arg });
        await screen(ctx, header('Раздел тега') + '\nТолько для порядка в списке выбора.', tagScopePicker(collections), true);
        return;
      }

      case CB.tagScope: {
        const dialog = await app.state.get(userId);
        const tagId = dialog.payload.tagId;
        if (!tagId) return;

        await app.tagBook.setScope(userId, tagId, arg === 'global' ? null : (arg ?? null));
        await showTagCard(ctx, userId, tagId, true);
        return;
      }

      case CB.tagDelete:
        if (!arg) return;
        await app.tagBook.delete(userId, arg);
        await app.search.flushDirty();
        await showTags(ctx, userId, 0, true);
        return;

      case CB.fieldsPage:
        await showFields(ctx, userId, Number(arg ?? '0'), true);
        return;

      case CB.fieldsSort: {
        const prefs = await app.fields.preferences(userId);
        await app.fields.setPreferences(userId, arg === 'desc' ? 'desc' : 'asc', prefs.filter);
        await showFields(ctx, userId, 0, true);
        return;
      }

      case CB.fieldsFilter: {
        const collections = await app.collections.list(userId);
        await screen(ctx, header('Показывать'), fieldFilterMenu(collections), true);
        return;
      }

      case CB.fieldsFilterSet: {
        const prefs = await app.fields.preferences(userId);
        await app.fields.setPreferences(userId, prefs.sort, arg === 'all' ? null : (arg ?? null));
        await showFields(ctx, userId, 0, true);
        return;
      }

      case CB.field:
        if (arg) await showField(ctx, userId, arg, true);
        return;

      case CB.fieldNew:
        await app.state.set(userId, 'field:key');
        await ctx.reply('Название поля?\n\nНапример: <code>Статус</code>', ASK);
        return;

      case CB.fieldType: {
        const dialog = await app.state.get(userId);

        // Правка существующего поля: тип меняется сразу.
        if (dialog.payload.defId) {
          const type = arg === 'auto' ? null : ((arg ?? null) as PropertyType | null);
          const conflict = await app.fields.setType(userId, dialog.payload.defId, type);
          if (conflict) {
            await ctx.reply(conflict);
            return;
          }

          // Старые значения не переписываем — предупреждаем честно.
          const stale = type ? await app.fields.countMismatched(userId, dialog.payload.defId, type) : 0;
          if (stale > 0) {
            await ctx.reply(
              `Тип изменён. ${stale} уже записанных значений остались прежнего типа — ` +
                `проверка касается только нового ввода, а сравнения в поиске их не увидят.`,
            );
          }

          await showField(ctx, userId, dialog.payload.defId, true);
          return;
        }

        if (!dialog.payload.key) return;

        const collections = await app.collections.list(userId);
        await app.state.set(userId, 'field:scope', {
          ...dialog.payload,
          type: arg === 'auto' ? '' : (arg ?? ''),
        });
        await screen(ctx, header('Где доступно') + '\nВезде или только в одном разделе.', scopePicker(collections), true);
        return;
      }

      case CB.fieldScope: {
        const dialog = await app.state.get(userId);

        if (dialog.payload.defId) {
          const conflict = await app.fields.setScope(
            userId,
            dialog.payload.defId,
            arg === 'global' ? null : (arg ?? null),
          );
          if (conflict) {
            await ctx.reply(conflict);
            return;
          }
          await showField(ctx, userId, dialog.payload.defId, true);
          return;
        }

        const key = dialog.payload.key;
        if (!key) return;

        const defId = await app.fields.create(
          userId,
          key,
          (dialog.payload.type || null) as PropertyType | null,
          arg === 'global' ? null : (arg ?? null),
          'entry',
        );

        await app.state.set(userId, 'field:options', { defId });
        await ctx.reply(
          'Значения списком, через запятую?\n\nНапример: <code>смотрю, досмотрено, брошено</code>\n\nИли пропустите — тогда значение вводится вручную.',
          { ...HTML, reply_markup: new InlineKeyboard().text('Пропустить', `${CB.field}:${defId}`) },
        );
        return;
      }

      case CB.fieldAddOption:
        if (!arg) return;
        await app.state.set(userId, 'field:options', { defId: arg });
        await ctx.reply('Значения через запятую?', ASK);
        return;

      case CB.fieldDelete:
        if (!arg) return;
        await app.fields.delete(userId, arg);
        await showFields(ctx, userId, 0, true);
        return;

      case CB.fieldRename:
        if (!arg) return;
        await app.state.set(userId, 'field:rename', { defId: arg });
        await ctx.reply('Новое название поля?', ASK);
        return;

      case CB.fieldRetype: {
        if (!arg) return;
        // defId в состоянии отличает правку от создания: экран выбора
        // типа один и тот же, а ветки разные.
        await app.state.set(userId, 'idle', { defId: arg });
        await screen(ctx, header('Тип значения') + '\nОт типа зависит проверка ввода.', typePicker(), true);
        return;
      }

      case CB.fieldRescope: {
        if (!arg) return;
        const collections = await app.collections.list(userId);
        await app.state.set(userId, 'idle', { defId: arg });
        await screen(ctx, header('Где доступно'), scopePicker(collections), true);
        return;
      }

      case CB.fieldRetarget:
        if (!arg) return;
        await app.state.set(userId, 'idle', { defId: arg });
        await screen(ctx, header('Для чего') + '\nГде предлагать это поле.', targetPicker(arg), true);
        return;

      case CB.fieldTarget: {
        const dialog = await app.state.get(userId);
        const defId = dialog.payload.defId;
        if (!defId || !arg) return;

        const conflict = await app.fields.setTarget(userId, defId, arg as 'entry' | 'attachment' | 'any');
        if (conflict) {
          await ctx.reply(conflict);
          return;
        }
        await showField(ctx, userId, defId, true);
        return;
      }

      case CB.fieldOptions:
        if (arg) await showOptions(ctx, userId, arg, 0);
        return;

      case CB.optionsPage: {
        const dialog = await app.state.get(userId);
        if (dialog.payload.defId) await showOptions(ctx, userId, dialog.payload.defId, Number(arg ?? '0'));
        return;
      }

      case CB.renameAttachment:
        if (!arg) return;
        await app.state.set(userId, 'attachment:rename', { attachmentId: arg });
        await ctx.reply('Новое название вложения?', ASK);
        return;

      case CB.renameOption: {
        if (!arg) return;
        const dialog = await app.state.get(userId);
        await app.state.set(userId, 'option:rename', { optionId: arg, defId: dialog.payload.defId ?? '' });
        await ctx.reply('Новое название значения?', ASK);
        return;
      }

      case CB.deleteOption: {
        if (!arg) return;
        const defId = await app.fields.deleteOption(userId, arg);
        if (defId) await showOptions(ctx, userId, defId, 0);
        return;
      }

      case CB.collectionsPage: {
        const collections = await app.collections.list(userId);
        await screen(ctx, header('Разделы'), collectionsMenu(collections, Number(arg ?? '0')), true);
        return;
      }

      case CB.tagPage: {
        const dialog = await app.state.get(userId);
        if (!dialog.payload.target) {
          await ctx.reply('Экран устарел — откройте запись заново.');
          return;
        }
        await showTagPicker(ctx, userId, dialog.payload.target, true, Number(arg ?? '0'));
        return;
      }

      case CB.keyPage: {
        const dialog = await app.state.get(userId);
        if (!dialog.payload.target) {
          await ctx.reply('Экран устарел — откройте запись заново.');
          return;
        }
        await showKeyPicker(ctx, userId, dialog.payload.target, true, Number(arg ?? '0'));
        return;
      }

      case CB.toggleTag: {
        if (!arg) return;
        const dialog = await app.state.get(userId);
        const objectId = dialog.payload.target;
        if (!objectId) {
          await ctx.reply('Экран устарел — откройте запись заново.');
          return;
        }

        // Один тап ставит, второй снимает: отдельного «удалить» не нужно.
        const current = await app.entries.tagIdsOf(objectId);
        if (current.includes(arg)) {
          await app.removeTag(userId, objectId, arg);
        } else {
          await app.attachTag(userId, objectId, arg);
        }

        // Возвращаем на ту же страницу: отметить тег и улететь на первую —
        // худший способ потерять пользователя посреди выбора.
        await showTagPicker(ctx, userId, objectId, true, Number(dialog.payload.page ?? '0'));
        return;
      }

      case CB.newTag:
        if (!arg) return;
        await app.state.set(userId, 'tag:name', { objectId: arg });
        await ctx.reply('Тег? Можно несколько через запятую.', ASK);
        return;

      case CB.pickKey: {
        const dialog = await app.state.get(userId);
        const objectId = dialog.payload.target;
        if (!objectId || !dialog.payload.keys) {
          await ctx.reply('Экран устарел — откройте запись заново.');
          return;
        }

        let picks: Array<{ key: string; defId: string | null }> = [];
        try {
          picks = JSON.parse(dialog.payload.picks ?? '[]') as typeof picks;
        } catch {
          picks = [];
        }

        const pick = picks[Number(arg ?? '-1')];
        if (!pick) {
          await ctx.reply('Поле не найдено — попробуйте ещё раз.');
          return;
        }

        await askValue(ctx, userId, objectId, pick.key, pick.defId);
        return;
      }

      case CB.valuePage: {
        const dialog = await app.state.get(userId);
        if (!dialog.payload.objectId || !dialog.payload.key) return;
        await askValue(
          ctx,
          userId,
          dialog.payload.objectId,
          dialog.payload.key,
          dialog.payload.defId ?? null,
          Number(arg ?? '0'),
        );
        return;
      }

      case CB.pickValue: {
        const dialog = await app.state.get(userId);
        const { objectId, key } = dialog.payload;
        if (!objectId || !key) return;

        let values: string[] = [];
        try {
          values = JSON.parse(dialog.payload.values ?? '[]') as string[];
        } catch {
          values = [];
        }

        const value = values[Number(arg ?? '-1')];
        if (value === undefined) return;

        await app.setValidatedProperty(userId, objectId, key, value, null);
        await app.state.clear(userId);
        await showObject(ctx, userId, objectId);
        return;
      }

      case CB.newValue: {
        const dialog = await app.state.get(userId);
        const { objectId, key } = dialog.payload;
        if (!objectId || !key) return;

        await app.state.set(userId, 'property:value', {
          objectId,
          key,
          defId: dialog.payload.defId ?? '',
        });
        await ctx.reply(`Значение для «${esc(key)}»?`, ASK);
        return;
      }

      case CB.newKey:
        if (!arg) return;
        await app.state.set(userId, 'property:key', { objectId: arg });
        await ctx.reply(
          'Название поля?\n\nНапример: <code>Озвучка</code>, <code>Оценка</code>, <code>Начал</code>',
          ASK,
        );
        return;

      case CB.addNote:
        if (!arg) return;
        await app.state.set(userId, 'note:text', { objectId: arg });
        await ctx.reply('Текст заметки или цитаты?', ASK);
        return;

      case CB.addMedia:
        if (!arg) return;
        await app.state.set(userId, 'idle', { attachTo: arg });
        await ctx.reply('Пришлите или перешлите медиа — фото, видео, голосовое, документ.', ASK);
        return;

      case CB.deleteEntry:
        if (!arg) return;
        await app.entries.delete(userId, arg);
        await ctx.reply('Запись удалена.');
        await showMenu(ctx, userId);
        return;
    }
  });

  // ---------------------------------------------------------------------
  // Медиа
  // ---------------------------------------------------------------------

  bot.on(
    [':photo', ':video', ':voice', ':audio', ':document', ':animation', ':video_note', ':sticker'],
    async (ctx) => {
      const userId = userIdOf(ctx);
      if (!userId || !ctx.message) return;

      await app.users.ensure(userId, ctx.from?.username ?? null, ctx.from?.first_name ?? null);

      const media = extractMedia(ctx.message);
      if (!media) return;

      /**
       * Расшифровка речи. Делаем до сохранения, чтобы текст попал в индекс
       * сразу же, а не после второй правки. Отказ модели не должен мешать:
       * при null вложение сохраняется как раньше, просто без текста.
       */
      const speech = ['voice', 'audio', 'video_note'].includes(media.mediaType)
        ? await transcribe({ botToken: token, groqToken }, media.fileId)
        : null;

      const dialog = await app.state.get(userId);

      // Сценарий «добавить медиа к открытой записи».
      const attachTo = dialog.payload.attachTo;
      if (attachTo) {
        const attachmentId = await app.attachMedia(userId, attachTo, media);
        if (speech) {
          await app.setTranscript(attachmentId, speech);
          // «Голосовое 1» ни о чём не говорит. Сказанное — говорит.
          await app.entries.rename(userId, attachmentId, speech.slice(0, 60));
        }
        await app.state.clear(userId);
        await showCard(ctx, userId, attachTo);
        return;
      }

      // Основной сценарий: переслали боту что-то — сохраняем в два тапа.
      const pending = {
        // Сказанное — лучшее название, чем «Голосовое от 26.07».
        title: speech ? speech.slice(0, 120) : titleForMedia(media),
        media: JSON.stringify(media),
        speech: speech ?? '',
      };

      /**
       * Наговоренное ведёт себя как набранное: сначала ищем.
       *
       * Человек, сказавший «найди Ваню Дмитриенко», хочет поиск, а не
       * запись с таким названием. Понимать команды по-настоящему будет
       * разбор намерений; пока достаточно того же правила, что и для
       * текста — а голосовое остаётся под рукой, кнопка сохранения никуда
       * не делась.
       */
      if (speech) {
        /**
         * Сначала пробуем понять сказанное моделью: «оценка больше равно
         * четыре» превращается в настоящий фильтр, чего никаким разбором
         * строки не добиться. Не вышло — откатываемся на поиск по словам,
         * то есть на прежнее поведение.
         */
        const context = await app.intentContext(userId);
        const parsed = await parseIntent(groqToken, speech, context);

        const query = stripCommandPrefix(speech);
        const hits =
          parsed?.intent === 'search'
            ? await app.findParsed(userId, parsed.query)
            : await app.find(userId, query);
        await app.state.set(userId, 'entry:collection', pending);

        const keyboard =
          hits.items.length > 0
            ? hitList(hits).row().text('💾 Сохранить голосовое', CB.savePending)
            : saveOffer();

        const shown = parsed?.intent === 'search' ? describeQuery(parsed.query, speech) : query;
        const sites = await app.sitesFor(userId, hits.items, parsed?.query ?? parseQuery(query));
        await ctx.reply(renderHits(hits, shown, sites), { ...HTML, reply_markup: keyboard });
        return;
      }

      const collections = await app.collections.list(userId);

      if (collections.length === 0) {
        await app.state.set(userId, 'collection:name', pending);
        await ctx.reply('Сохраню. Сначала создайте раздел — как его назвать?\n\nНапример: <code>📺 Донхуа</code>', HTML);
        return;
      }

      await app.state.set(userId, 'entry:collection', pending);
      await ctx.reply(`Сохранить как <b>${esc(pending.title)}</b>?\n\nВ какой раздел?`, {
        ...HTML,
        reply_markup: collectionPicker(collections),
      });
    },
  );

  // ---------------------------------------------------------------------
  // Текст — продолжение активного мастера
  // ---------------------------------------------------------------------

  bot.on('message:text', async (ctx) => {
    const userId = userIdOf(ctx);
    if (!userId) return;

    await app.users.ensure(userId, ctx.from?.username ?? null, ctx.from?.first_name ?? null);

    const input = ctx.message.text.trim();
    const dialog = await app.state.get(userId);

    switch (dialog.state) {
      case 'collection:name': {
        // Ведущее эмодзи становится иконкой раздела.
        const match = /^(\p{Extended_Pictographic}️?)\s*(.+)$/u.exec(input);
        const icon = match ? match[1]! : null;
        const name = match ? match[2]! : input;

        const problem = NoteKeeper.validateName(name);
        if (problem) {
          // Состояние не сбрасываем: человек просто вводит заново.
          await ctx.reply(`${problem}\n\nВведите название раздела ещё раз.`);
          return;
        }

        const collection = await app.createCollection(userId, name, icon);
        await ctx.reply(`Раздел ${collection.icon ?? '📁'} <b>${esc(collection.name)}</b> создан.`, HTML);

        // Раздел мог создаваться посреди сохранения — тогда доводим до конца.
        if (dialog.payload.title) {
          await commitPending(ctx, userId, collection.id);
          return;
        }

        // …или посреди создания записи: возвращаемся к тому, что просили.
        if (dialog.payload.then === 'entry') {
          await app.state.set(userId, 'entry:title');
          await ctx.reply('Название записи?', ASK);
          return;
        }

        await app.state.clear(userId);
        await showMenu(ctx, userId);
        return;
      }

      case 'entry:title': {
        const collections = await app.collections.list(userId);
        await app.state.set(userId, 'entry:collection', { title: input });
        await ctx.reply('В какой раздел?', { reply_markup: collectionPicker(collections) });
        return;
      }

      case 'property:key':
        await app.state.set(userId, 'property:value', { ...dialog.payload, key: input });
        await ctx.reply(`Значение для «${esc(input)}»?`, ASK);
        return;

      case 'property:value': {
        const objectId = dialog.payload.objectId;
        const key = dialog.payload.key;
        if (!objectId || !key) {
          await app.state.clear(userId);
          await ctx.reply('Мастер устарел — начните заново.');
          return;
        }
        // Тип известен только у полей справочника — иначе как раньше,
        // тип угадывается по значению.
        const def = dialog.payload.defId ? await app.fields.find(userId, dialog.payload.defId) : null;
        const problem = await app.setValidatedProperty(userId, objectId, key, input, def?.type ?? null);

        if (problem) {
          // Состояние не трогаем: человек вводит заново, ничего не теряя.
          await ctx.reply(`${problem}\n\nВведите значение ещё раз.`, ASK);
          return;
        }

        await app.state.clear(userId);
        await showObject(ctx, userId, objectId);
        return;
      }

      case 'tag:name': {
        const objectId = dialog.payload.objectId;
        if (!objectId) return;
        // Несколько тегов за раз: "культивация, любимое".
        for (const tag of input.split(/[,\s]+/).filter(Boolean)) {
          await app.addTag(userId, objectId, tag);
        }
        await app.state.clear(userId);
        await showObject(ctx, userId, objectId);
        return;
      }

      case 'note:text': {
        const objectId = dialog.payload.objectId;
        if (!objectId) return;
        await app.addNote(userId, objectId, input);
        await app.state.clear(userId);
        await showObject(ctx, userId, objectId);
        return;
      }

      case 'field:key': {
        const problem = NoteKeeper.validateName(input);
        if (problem) {
          await ctx.reply(`${problem}\n\nВведите название поля ещё раз.`, ASK);
          return;
        }

        await app.state.set(userId, 'field:type', { key: input });
        await ctx.reply(
          `Тип значения для «${esc(input)}»?\n\nОт типа зависит проверка ввода и сравнения в поиске.`,
          { ...HTML, reply_markup: typePicker() },
        );
        return;
      }

      case 'timezone': {
        const match = /^([+-]?\d{1,2})(?:[:.](\d{2}))?$/.exec(input.replace(/\s+/gu, ''));
        if (!match) {
          await ctx.reply('Нужно смещение от UTC: +3, -5, +5:30', ASK);
          return;
        }

        const hours = Number(match[1]);
        const minutes = (match[2] ? Number(match[2]) : 0) * Math.sign(hours || 1);
        await app.reminders.setTimezone(userId, hours * 60 + minutes);

        // Возвращаемся к тому, ради чего спрашивали.
        const phrase = dialog.payload.phrase;
        const objectId = dialog.payload.objectId ?? null;

        if (phrase) {
          const schedule = parseSchedule(
            phrase === 'evening' ? 'вечером' : phrase === 'tomorrow' ? 'завтра' : phrase,
            Date.now(),
            hours * 60 + minutes,
          );
          if (schedule) {
            await createReminder(ctx, userId, objectId, schedule.at, schedule.rule);
            return;
          }
        }

        await app.state.clear(userId);
        await ctx.reply(`Часовой пояс сохранён: UTC${hours >= 0 ? '+' : ''}${hours}`);
        return;
      }

      case 'reminder:when': {
        const reminderId = dialog.payload.reminderId;
        const objectId = dialog.payload.objectId ?? null;

        if (needsTimezone(input) && !(await ensureTimezone(ctx, userId, { ...dialog.payload, phrase: input }))) {
          return;
        }

        const offset = (await app.reminders.timezone(userId)) ?? 0;
        const schedule = parseSchedule(input, Date.now(), offset);

        if (!schedule) {
          await ctx.reply(
            'Не понял время. Попробуйте так: «через 40 минут», «завтра в 9», «05.08 в 18:30», «каждые 3 дня».',
            ASK,
          );
          return;
        }

        // Правка существующего или создание нового — экран один.
        if (reminderId) {
          await app.reminders.reschedule(userId, reminderId, new Date(schedule.at).toISOString());
          await app.state.clear(userId);
          await showReminder(ctx, userId, reminderId, false);
          return;
        }

        await createReminder(ctx, userId, objectId, schedule.at, schedule.rule);
        return;
      }

      case 'reminder:text': {
        const reminderId = dialog.payload.reminderId;
        if (!reminderId) return;

        await app.reminders.setText(userId, reminderId, input);
        await app.state.clear(userId);
        await showReminder(ctx, userId, reminderId, false);
        return;
      }

      case 'attachment:rename': {
        const attachmentId = dialog.payload.attachmentId;
        if (!attachmentId) return;

        await app.entries.rename(userId, attachmentId, input);
        await app.search.flushDirty();
        await app.state.clear(userId);
        await showObject(ctx, userId, attachmentId);
        return;
      }

      case 'note:edit': {
        const noteId = dialog.payload.noteId;
        if (!noteId) return;

        const parentId = await app.entries.updateNote(userId, noteId, input);
        await app.search.flushDirty();
        await app.state.clear(userId);

        if (parentId) await showObject(ctx, userId, parentId);
        return;
      }

      case 'collection:rename': {
        const collectionId = dialog.payload.collectionId;
        if (!collectionId) return;

        const problem = NoteKeeper.validateName(input);
        if (problem) {
          await ctx.reply(`${problem}\n\nВведите название ещё раз.`, ASK);
          return;
        }

        const conflict = await app.collections.rename(userId, collectionId, input);
        if (conflict) {
          await ctx.reply(`${conflict}\n\nВведите другое название.`, ASK);
          return;
        }

        await app.state.clear(userId);
        const page = await app.byCollection(userId, collectionId, 0);
        await ctx.reply(renderList(page, 'Раздел переименован'), {
          ...HTML,
          reply_markup: entryList(page, `${CB.collection}:${collectionId}:`, collectionId),
        });
        return;
      }

      case 'collection:icon': {
        const collectionId = dialog.payload.collectionId;
        if (!collectionId) return;

        const icon = /^убрать$/i.test(input) ? null : /^\p{Extended_Pictographic}️?$/u.exec(input)?.[0];
        if (icon === undefined) {
          await ctx.reply('Нужен один эмодзи или слово «убрать».', ASK);
          return;
        }

        await app.collections.setIcon(userId, collectionId, icon);
        await app.state.clear(userId);
        const collection = await app.collections.find(userId, collectionId);
        await ctx.reply(`Значок обновлён: ${collection?.icon ?? '📁'} <b>${esc(collection?.name ?? '')}</b>`, {
          ...HTML,
          reply_markup: collectionCard(collectionId),
        });
        return;
      }

      case 'tag:new': {
        const problem = NoteKeeper.validateName(input);
        if (problem) {
          await ctx.reply(`${problem}\n\nВведите название тега ещё раз.`, ASK);
          return;
        }

        const tagId = await app.tagBook.create(userId, input.replace(/^#/, ''), null);
        await app.state.clear(userId);
        await showTagCard(ctx, userId, tagId, false);
        return;
      }

      case 'tag:rename': {
        const tagId = dialog.payload.tagId;
        if (!tagId) return;

        const problem = NoteKeeper.validateName(input);
        if (problem) {
          await ctx.reply(`${problem}\n\nВведите название ещё раз.`, ASK);
          return;
        }

        const conflict = await app.tagBook.rename(userId, tagId, input.replace(/^#/, ''));
        if (conflict) {
          await ctx.reply(`${conflict}\n\nВведите другое название.`, ASK);
          return;
        }

        // Тег виден в индексе поиска — после переименования перестроим.
        await app.search.flushDirty();
        await app.state.clear(userId);
        await showTagCard(ctx, userId, tagId, false);
        return;
      }

      case 'field:rename': {
        const defId = dialog.payload.defId;
        if (!defId) return;

        const problem = NoteKeeper.validateName(input);
        if (problem) {
          await ctx.reply(`${problem}\n\nВведите название ещё раз.`, ASK);
          return;
        }

        const conflict = await app.fields.rename(userId, defId, input);
        if (conflict) {
          await ctx.reply(`${conflict}\n\nВведите другое название.`, ASK);
          return;
        }

        await app.state.clear(userId);
        await showField(ctx, userId, defId, false);
        return;
      }

      case 'option:rename': {
        const optionId = dialog.payload.optionId;
        if (!optionId) return;

        const { defId, problem } = await app.fields.renameOption(userId, optionId, input);
        if (problem) {
          // Мастер оставляем открытым — ввод не теряется.
          await ctx.reply(`${problem}\n\nВведите другое название.`, ASK);
          return;
        }

        await app.state.clear(userId);
        if (defId) await showOptions(ctx, userId, defId, 0);
        return;
      }

      case 'field:options': {
        const defId = dialog.payload.defId;
        if (!defId) return;

        await app.fields.addOptions(defId, input.split(',').map((value) => value.trim()));
        await app.state.clear(userId);
        await showField(ctx, userId, defId, false);
        return;
      }

      case 'search:query':
        await showSearch(ctx, userId, input, 0);
        return;

      default:
        // Свободный текст без мастера — самый частый вход. Не заставляем
        // вспоминать команды: сразу ищем, а если пусто — предлагаем сохранить.
        await showSearch(ctx, userId, input, 0);
    }
  });

  bot.catch((error) => {
    console.error('bot error', error.error);
  });

  return bot;
}
