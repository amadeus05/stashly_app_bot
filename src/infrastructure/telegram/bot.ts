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
  keyPicker,
  manageMenu,
  tagPicker,
  collectionsMenu,
  entryList,
  hitList,
  mainMenu,
  saveOffer,
} from './keyboards.js';
import { extractMedia, titleForMedia } from './media.js';
import { esc, header, renderAttachment, renderCard, renderHits, renderList } from './render.js';
import { formatValue } from '../../domain/property.js';

const HTML = { parse_mode: 'HTML' } as const;

/** Ответ на шаге, где бот ждёт ввода: всегда с видимой отменой. */
const ASK = { parse_mode: 'HTML', reply_markup: cancelOnly() } as const;

export function createBot(token: string, db: D1Database, botInfo?: UserFromGetMe): Bot {
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

  /** Сколько подсказок помещается на экран, не превращая его в простыню. */
  const SUGGEST_LIMIT = 12;

  /** Экран выбора тегов: уже заведённые с отметками + «написать новый». */
  async function showTagPicker(ctx: Context, userId: number, objectId: string, edit: boolean): Promise<void> {
    const object = await app.entries.findById(userId, objectId);
    if (!object) return;

    const collectionId = await app.entries.collectionIdOf(objectId);
    const [tags, selected] = await Promise.all([
      app.entries.suggestTags(userId, collectionId, SUGGEST_LIMIT),
      app.entries.tagIdsOf(objectId),
    ]);

    await app.state.set(userId, 'idle', { target: objectId });

    // Первый тег заводить неоткуда — сразу просим ввести.
    if (tags.length === 0) {
      await app.state.set(userId, 'tag:name', { objectId });
      await ctx.reply('Тегов пока нет. Введите первый — можно несколько через запятую.', ASK);
      return;
    }

    await screen(
      ctx,
      header('Теги') + '\nНажмите, чтобы поставить или снять. Сверху — те, что уже использовали в этом разделе.',
      tagPicker(tags, new Set(selected), objectId, object.type === 'attachment'),
      edit,
    );
  }

  /** Экран выбора названия поля из уже использованных. */
  async function showKeyPicker(ctx: Context, userId: number, objectId: string, edit: boolean): Promise<void> {
    const object = await app.entries.findById(userId, objectId);
    if (!object) return;

    const collectionId = await app.entries.collectionIdOf(objectId);
    const keys = await app.entries.suggestKeys(userId, object.type, collectionId, SUGGEST_LIMIT);

    if (keys.length === 0) {
      await app.state.set(userId, 'property:key', { objectId });
      await ctx.reply(
        'Название поля?\n\nНапример: <code>Озвучка</code>, <code>Оценка</code>, <code>Начал</code>',
        ASK,
      );
      return;
    }

    // Список кладём в состояние: в callback_data влезает только индекс.
    await app.state.set(userId, 'idle', { target: objectId, keys: JSON.stringify(keys) });

    await screen(
      ctx,
      header('Название поля') + '\nВыберите из тех, что уже используете, или задайте своё.',
      keyPicker(keys, objectId, object.type === 'attachment'),
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

  /** Показ результатов + запоминание запроса: в callback_data он не влезет. */
  async function showSearch(ctx: Context, userId: number, query: string, page: number, edit = false): Promise<void> {
    const hits = await app.find(userId, query, page);
    await app.state.set(userId, 'idle', { lastQuery: query });

    const text = renderHits(hits, query);
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

    const entryId = await app.saveIncoming(userId, collectionId, title, media);
    await app.state.clear(userId);
    await showCard(ctx, userId, entryId);
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

        const page = await app.byCollection(arg, Number(extra ?? '0'));
        await screen(ctx, renderList(page, 'Раздел'), entryList(page, `${CB.collection}:${arg}:`, arg), true);
        return;
      }

      case CB.deleteCollection: {
        if (!arg) return;

        const count = await app.collections.countEntries(arg);
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
        await app.removeTag(objectId, arg);
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
          await app.removeTag(objectId, arg);
        } else {
          await app.attachTag(userId, objectId, arg);
        }

        await showTagPicker(ctx, userId, objectId, true);
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

        let keys: string[] = [];
        try {
          keys = JSON.parse(dialog.payload.keys) as string[];
        } catch {
          keys = [];
        }

        const key = keys[Number(arg ?? '-1')];
        if (!key) {
          await ctx.reply('Поле не найдено — попробуйте ещё раз.');
          return;
        }

        await app.state.set(userId, 'property:value', { objectId, key });
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

      const dialog = await app.state.get(userId);

      // Сценарий «добавить медиа к открытой записи».
      const attachTo = dialog.payload.attachTo;
      if (attachTo) {
        await app.attachMedia(userId, attachTo, media);
        await app.state.clear(userId);
        await showCard(ctx, userId, attachTo);
        return;
      }

      // Основной сценарий: переслали боту что-то — сохраняем в два тапа.
      const collections = await app.collections.list(userId);
      const pending = { title: titleForMedia(media), media: JSON.stringify(media) };

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
        await app.setProperty(userId, objectId, key, input);
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
