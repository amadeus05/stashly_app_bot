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
  'has:голосовое',
  'tag:favorite',
  '12:34',
  '01.07.2026',
  'Ту Сы',
  'раздел:донхуа has:фото',
  'небеса AND OR "*" ((',
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
check('оценка>=абв — текст', parseQuery('оценка>=абв').text, 'оценка>=абв');
check('неизвестный has игнорируется', parseQuery('has:чепуха').has, []);
check('синтаксис FTS обезврежен', toMatchExpression('AND OR "*" (( небеса'), '"AND" AND "OR" AND "небеса"');
check('пустой запрос', toMatchExpression('   '), null);

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
