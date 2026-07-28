// Перехватывает SQL, который реально генерируют репозитории,
// чтобы затем проиграть его на настоящем SQLite.
import { writeFileSync } from 'node:fs';
import { NoteKeeper } from '../.test-build/application/service.js';

const log = [];
let dirtyFixture = [];

const stmt = (sql, binds = []) => ({
  sql,
  binds,
  bind: (...args) => stmt(sql, args),
  async run() { log.push({ sql, binds }); return { success: true }; },
  async all() {
    log.push({ sql, binds });
    if (/FROM search_dirty/.test(sql)) return { results: dirtyFixture.map((id) => ({ object_id: id })) };
    if (/FROM search_index|WITH matches/.test(sql)) { capturedSearch.push({ sql, binds }); return { results: [] }; }
    return { results: [] };
  },
  async first() { log.push({ sql, binds }); return null; },
});

const capturedSearch = [];
const db = {
  prepare: (sql) => stmt(sql),
  async batch(statements) { for (const s of statements) log.push({ sql: s.sql, binds: s.binds }); return []; },
};

const app = new NoteKeeper(db);
const USER = 1;

await app.users.ensure(USER, 'amadeus', 'A');
const collection = await app.collections.create(USER, 'Донхуа', '📺');
const entryId = await app.entries.createEntry(USER, 'Противостояние святого', [collection.id]);

await app.setProperty(USER, entryId, 'Озвучка', 'AniStar');
await app.setProperty(USER, entryId, 'Оценка', '9,8');
await app.setProperty(USER, entryId, 'Серия', '128');
await app.setProperty(USER, entryId, 'Начал', '01.07.2026');
await app.setProperty(USER, entryId, 'Ссылка', 'https://example.com/watch');
await app.setProperty(USER, entryId, 'Любимое', 'да');
await app.addTag(USER, entryId, 'культивация');
await app.addTag(USER, entryId, 'favorite');
await app.addNote(USER, entryId, 'Лучшая битва с Ту Сы');

const attachmentId = await app.entries.addAttachment(USER, entryId, {
  mediaType: 'photo', fileId: 'AgACAgIAAx', fileUniqueId: 'AQADabc', caption: 'Первый бой',
});
await app.setProperty(USER, attachmentId, 'Тайминг', '12:34');
await app.setProperty(USER, attachmentId, 'Персонаж', 'Ван Линь');
await app.setProperty(USER, attachmentId, 'Серия', '83');
await app.addNote(USER, attachmentId, 'Надо пересмотреть');

// Переиндексация всех созданных объектов.
dirtyFixture = [entryId, attachmentId];
const noteIds = log.filter((e) => /type, parent_id, body/.test(e.sql)).map((e) => e.binds[0]);
dirtyFixture = [entryId, attachmentId, ...noteIds];
await app.search.flushDirty();

const queries = [
  'anistar',
  'пересмотреть',
  'Линь',
  'битва',
  'раздел:донхуа оценка>=9 tag:favorite has:фото',
  'серия>100',
  'озвучка:anistar',
  'оценка:9.8',
  'серия:128',
  'has:голосовое',
  'tag:favorite',
  '12:34',
  '01.07.2026',
  'Ту Сы',
  'раздел:донхуа has:фото',
  'небеса AND OR "*" ((',
  'прот',
  'anis',
  'Ван Ли',
  'я',
];
const searchSql = [];
for (const q of queries) {
  capturedSearch.length = 0;
  await app.find(USER, q);
  searchSql.push({ query: q, ...capturedSearch[0] });
}

// Подсказки тегов и полей: группировка с LEFT JOIN, проверяем на живом SQLite.
await app.entries.suggestTags(USER, collection.id, 12);
await app.entries.suggestKeys(USER, 'entry', collection.id, 12);
await app.entries.suggestKeys(USER, 'attachment', collection.id, 12);
await app.entries.tagIdsOf(entryId);
await app.entries.collectionIdOf(attachmentId);
await app.entries.attachTag(USER, entryId, 't1');

// Запросы со страницами и сохранение присланного — только на синтаксис:
// шим не возвращает строк, содержательные проверки ниже, на чистых функциях.
await app.recent(USER, 3);
await app.byCollection(collection.id, 2);
await app.saveIncoming(USER, collection.id, 'Из пересланного', {
  mediaType: 'voice', fileId: 'AwACx', fileUniqueId: 'AQADv', duration: 7,
});

// --- чистые функции: без БД, проверяем поведение, а не синтаксис ---
const { parseQuery, toMatchExpression } = await import('../.test-build/domain/query.js');
const { inferValue, formatValue } = await import('../.test-build/domain/property.js');

let failed = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed++; console.log(`  FAIL ${name}\n    ожидалось ${JSON.stringify(expected)}\n    получено  ${JSON.stringify(actual)}`); }
  else console.log(`  ok   ${name}`);
};

console.log('\nразбор запроса:');
check('фильтры отделены от текста',
  parseQuery('раздел:донхуа оценка>=9 tag:любимое has:фото небеса хотят'),
  { text: 'небеса хотят', tags: ['любимое'], collections: ['донхуа'],
    properties: [{ key: 'оценка', op: '>=', num: 9 }], has: ['image'] });
check('12:34 — текст, а не фильтр', parseQuery('12:34').text, '12:34');
check('пробелы вокруг знака не мешают',
  parseQuery('оценка >= 9').properties, [{ key: 'оценка', op: '>=', num: 9 }]);
check('пробел после двоеточия не мешает', parseQuery('tag: любимое').tags, ['любимое']);
check('свободный текст с пробелами цел', parseQuery('лучшая битва').text, 'лучшая битва');
check('оценка>=абв — текст', parseQuery('оценка>=абв').text, 'оценка>=абв');
check('неизвестный has игнорируется', parseQuery('has:чепуха').has, []);
check('синтаксис FTS обезврежен', toMatchExpression('AND OR "*" (( небеса'), '"AND"* AND "OR"* AND "небеса"*');
check('поиск по началу слова', toMatchExpression('дон'), '"дон"*');
check('один символ — без звёздочки', toMatchExpression('я'), '"я"');
check('пустой запрос', toMatchExpression('   '), null);

// Наговоренное «найди X»: слова «найди» в записях нет, и поиск по всем
// словам сразу вернул бы пусто.
const { stripCommandPrefix } = await import('../.test-build/domain/query.js');
check('команда отброшена', stripCommandPrefix('Найди Ваня Дмитриенко.'), 'Ваня Дмитриенко.');
check('латиница тоже', stripCommandPrefix('find Ivan'), 'Ivan');
check('слово целиком, не начало', stripCommandPrefix('Найденное сокровище'), 'Найденное сокровище');
check('одинокое «найди» не пустеет', stripCommandPrefix('найди'), 'найди');
check('обычная фраза не тронута', stripCommandPrefix('лучшая битва'), 'лучшая битва');

// Модель возвращает лишние поля, строку вместо числа, выдуманный
// оператор. Проверяем не модель, а то, что мы делаем с её ответом.
console.log('\nразбор ответа модели:');
const { toParsedQuery } = await import('../.test-build/ai/intent.js');

check('оценка больше равно 4',
  toParsedQuery({ intent: 'search', text: '', properties: [{ key: 'Оценка', op: '>=', value: '4' }] }).query.properties,
  [{ key: 'оценка', op: '>=', num: 4 }]);
check('намерение распознано',
  toParsedQuery({ intent: 'search', text: 'ваня' }).intent, 'search');
check('пустой разбор — unknown',
  toParsedQuery({ intent: 'search', text: '' }).intent, 'unknown');
check('мусор вместо объекта не роняет', toParsedQuery(null).intent, 'unknown');
check('выдуманный оператор отброшен',
  toParsedQuery({ intent: 'search', text: 'x', properties: [{ key: 'a', op: '≈', value: 1 }] }).query.properties, []);
check('нечисло в сравнении отброшено',
  toParsedQuery({ intent: 'search', text: 'x', properties: [{ key: 'a', op: '>', value: 'хорошо' }] }).query.properties, []);
check('равенство принимает текст',
  toParsedQuery({ intent: 'search', properties: [{ key: 'Озвучка', op: '=', value: 'AniStar' }] }).query.properties,
  [{ key: 'озвучка', op: '=', text: 'AniStar' }]);
check('неизвестный has отброшен',
  toParsedQuery({ intent: 'search', text: 'x', has: ['фото', 'image'] }).query.has, ['image']);
check('теги приводятся к нижнему регистру',
  toParsedQuery({ intent: 'search', tags: ['Любимое'] }).query.tags, ['любимое']);

console.log('\nтипы значений:');
check('9,8 -> number', inferValue('9,8'), { type: 'number', valueText: null, valueNum: 9.8, valueDate: null });
check('12:34 -> duration 754с', inferValue('12:34').valueNum, 754);
check('1:02:03 -> duration 3723с', inferValue('1:02:03').valueNum, 3723);
check('01.07.2026 -> date', inferValue('01.07.2026').valueDate, '2026-07-01T00:00:00.000Z');
check('да -> bool', inferValue('да'), { type: 'bool', valueText: null, valueNum: 1, valueDate: null });
check('ссылка -> url', inferValue('https://a.b/c').type, 'url');
check('AniStar -> text', inferValue('AniStar').type, 'text');
check('duration туда-обратно', formatValue({ ...inferValue('12:34'), key: 'k', id: '', objectId: '' }), '12:34');
check('date туда-обратно', formatValue({ ...inferValue('01.07.2026'), key: 'k', id: '', objectId: '' }), '01.07.2026');

// Регрессия с живого запуска: пользователь скопировал пример фильтров
// из подсказки бота и вставил его как название раздела.
console.log('\nвалидация названия раздела:');
const bad = (s) => NoteKeeper.validateName(s) !== null;
check('обычное название проходит', NoteKeeper.validateName('Донхуа'), null);
check('название с пробелами проходит', NoteKeeper.validateName('Мои книги 2026'), null);
check('поисковый запрос отклонён', bad('раздел:донхуа оценка>=9 tag:любимое has:фото'), true);
check('одиночный фильтр отклонён', bad('tag:любимое'), true);
check('команда отклонена', bad('/start'), true);
check('пустое отклонено', bad('   '), true);
check('слишком длинное отклонено', bad('я'.repeat(65)), true);
check('64 символа проходят', NoteKeeper.validateName('я'.repeat(64)), null);

// Индекс поля передаётся в callback_data. Если он считается от начала
// страницы, а не всего списка, на второй странице выберется чужое поле.
// Без проверки типа поле «Оценка» с текстом «девять» молча выпало бы
// из фильтра «оценка>=9» — неполная выдача вместо ошибки.
console.log('\nпроверка значения по типу поля:');
const { coerceValue } = await import('../.test-build/domain/property.js');

check('число принимает число', coerceValue('9.8', 'number').value.valueNum, 9.8);
check('число отвергает текст', coerceValue('девять', 'number').problem !== null, true);
check('в отказе есть пример', coerceValue('девять', 'number').problem.includes('9'), true);
check('дата принимает 01.07.2026', coerceValue('01.07.2026', 'date').value.valueDate, '2026-07-01T00:00:00.000Z');
check('дата отвергает мусор', coerceValue('вчера', 'date').problem !== null, true);
check('тайминг принимает 12:34', coerceValue('12:34', 'duration').value.valueNum, 754);
check('да-нет принимает «нет»', coerceValue('нет', 'bool').value.valueNum, 0);
check('текст принимает цифры как текст', coerceValue('12 из 24', 'text').value.type, 'text');
check('текстовое поле не станет числом', coerceValue('9', 'text').value.type, 'text');
check('ссылке дописывается схема', coerceValue('example.com/a', 'url').value.valueText, 'https://example.com/a');
check('без объявленного типа — как раньше', coerceValue('9,8', null).value.type, 'number');

console.log('\nпагинация списков выбора:');
const { keyPicker, tagPicker, PICKER_PAGE } = await import('../.test-build/infrastructure/telegram/keyboards.js');
const many = Array.from({ length: 20 }, (_, i) => `Поле${i}`);

const rows0 = keyPicker(many, 'obj', false, 0).inline_keyboard.flat();
const rows1 = keyPicker(many, 'obj', false, 1).inline_keyboard.flat();
const idx = (rows) => rows.filter((b) => b.callback_data?.startsWith('pk:')).map((b) => Number(b.callback_data.split(':')[1]));

check('на странице ровно PICKER_PAGE полей', idx(rows0).length, PICKER_PAGE);
check('индексы первой страницы', idx(rows0), [0, 1, 2, 3, 4, 5, 6, 7]);
check('индексы второй страницы сквозные', idx(rows1), [8, 9, 10, 11, 12, 13, 14, 15]);
check('счётчик показывает 2/3', rows1.some((b) => b.text === '2/3'), true);
check('стрелки закольцованы', keyPicker(many, 'obj', false, 2).inline_keyboard.flat().some((b) => b.callback_data === 'kp:0'), true);
check('одна страница — без листалки',
  keyPicker(['A'], 'obj', false, 0).inline_keyboard.flat().some((b) => b.text === '1/1'), false);
check('страница за пределами зажимается',
  idx(keyPicker(many, 'obj', false, 99).inline_keyboard.flat()), [16, 17, 18, 19]);

const tags = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, name: `тег${i}` }));
const tagRows = tagPicker(tags, new Set(['t9']), 'obj', false, 1).inline_keyboard.flat();
check('отметка сохраняется на второй странице',
  tagRows.some((b) => b.text.startsWith('✅') && b.text.includes('тег9')), true);

// Превышение лимита Telegram — это не обрезка, а отказ отправить:
// карточка с длинными заметками просто перестала бы открываться.
console.log('\nлимиты длины сообщения:');
const { renderCard, renderAttachment } = await import('../.test-build/infrastructure/telegram/render.js');

const song = Array.from({ length: 60 }, (_, i) => `Am    C    F E\nСтрока песни номер ${i}`).join('\n');
const note = (body, id) => ({ id, type: 'note', body, createdAt: '2026-07-26T10:00:00.000Z', parentId: 'e', userId: 1, title: null, updatedAt: '' });

const bigCard = renderCard({
  entry: { id: 'e', type: 'entry', title: 'Звери - Говори', body: null, createdAt: '2026-07-26T10:00:00.000Z', updatedAt: '', parentId: null, userId: 1 },
  collections: [{ id: 'c', userId: 1, name: 'Песни под гитару', icon: '📔' }],
  properties: [], tags: [],
  notes: [note(song, 'n1'), note(song, 'n2'), note(song, 'n3')],
  attachments: [],
});

check('карточка влезает в лимит сообщения', bigCard.length <= 4096, true);
check('длинная заметка — под катом', bigCard.includes('<blockquote expandable>'), true);
check('обрезка не рвёт тег', (bigCard.match(/</g) || []).length === (bigCard.match(/>/g) || []).length, true);
check('короткая заметка остаётся строкой',
  renderCard({
    entry: { id: 'e', type: 'entry', title: 'т', body: null, createdAt: '2026-07-26T10:00:00.000Z', updatedAt: '', parentId: null, userId: 1 },
    collections: [], properties: [], tags: [], notes: [note('коротко', 'n')], attachments: [],
  }).includes('<blockquote expandable>'), false);

const caption = renderAttachment({
  object: { id: 'a', type: 'attachment', title: 'Скрин', body: null, createdAt: '2026-07-26T10:00:00.000Z', updatedAt: '', parentId: 'e', userId: 1 },
  attachment: { mediaType: 'photo' }, properties: [], notes: [note(song, 'n1')],
}, 1);
check('подпись к медиа влезает в 1024', caption.length <= 1024, true);

// Списки записей показывают «2/3», только когда число страниц посчитано.
console.log('\nсчётчик в списках записей:');
const { entryList } = await import('../.test-build/infrastructure/telegram/keyboards.js');
const rows = (kb) => kb.inline_keyboard.flat().map((b) => b.text);

check('со счётчиком',
  rows(entryList({ items: [{ id: 'a', title: 'A' }], page: 1, hasMore: true, pages: 3 }, 'r:')).includes('2/3'), true);
check('без счётчика — стрелки',
  rows(entryList({ items: [{ id: 'a', title: 'A' }], page: 1, hasMore: true }, 'r:')).includes('➡️'), true);
check('одна страница — без листалки',
  rows(entryList({ items: [{ id: 'a', title: 'A' }], page: 0, hasMore: false, pages: 1 }, 'r:')).includes('1/1'), false);

console.log('\nпагинация:');
const shim = { prepare: () => stmt('SELECT 1'), batch: async () => [] };
const svc = new NoteKeeper(shim);
svc.entries.listRecent = async (_u, limit) => Array.from({ length: Math.min(limit, 9) }, (_, i) => ({ id: `x${i}` }));
const p = await svc.recent(USER, 0);
check('страница обрезана до PAGE_SIZE', p.items.length, 8);
check('есть следующая страница', p.hasMore, true);
svc.entries.listRecent = async () => [{ id: 'x0' }];
check('последняя страница', (await svc.recent(USER, 0)).hasMore, false);

if (failed) { console.log(`\nпровалено проверок: ${failed}`); process.exitCode = 1; }

writeFileSync(new URL('captured.json', import.meta.url), JSON.stringify({ log, searchSql, entryId, attachmentId }, null, 1));
console.log('statements:', log.length, '| search queries:', searchSql.length);
