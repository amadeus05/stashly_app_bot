// Разбор сказанного: проверяем, что модель не дописывает фильтры,
// которых человек не называл. Это её любимая ошибка — «За гранью
// времени» звучит как стихи, и она подставляет раздел «Стихи».
import { toParsedQuery } from '../.test-build/ai/intent.js';

let failed = 0;

function check(label, said, raw, expected) {
  const result = toParsedQuery(raw, said);
  const actual = {
    collections: result.query.collections,
    keys: result.query.properties.map((p) => p.key),
    tags: result.query.tags,
  };

  const ok = JSON.stringify(actual) === JSON.stringify({
    collections: expected.collections ?? [],
    keys: expected.keys ?? [],
    tags: expected.tags ?? [],
  });

  if (!ok) {
    failed += 1;
    console.error(`ПРОВАЛ  ${label}\n  сказано: ${said}\n  ждали:   ${JSON.stringify(expected)}\n  вышло:   ${JSON.stringify(actual)}`);
    return;
  }
  console.log(`ок      ${label}`);

}

const search = (extra) => ({ intent: 'search', text: '', ...extra });

check(
  'выдуманный раздел отбрасывается',
  'За гранью времени',
  search({ text: 'За гранью времени', collections: ['стихи'] }),
  { collections: [] },
);

check(
  'названный раздел остаётся',
  'найди в разделе стихи за гранью времени',
  search({ text: 'за гранью времени', collections: ['стихи'] }),
  { collections: ['стихи'] },
);

check(
  'склонение названия распознаётся',
  'покажи записи в стихах',
  search({ collections: ['стихи'] }),
  { collections: ['стихи'] },
);

check(
  'выдуманное поле отбрасывается',
  'за гранью времени',
  search({ text: 'за гранью времени', properties: [{ key: 'жанр', op: '=', value: 'поэзия' }] }),
  { keys: [] },
);

check(
  'названное поле остаётся',
  'донхуа с оценкой больше 9',
  search({ collections: ['донхуа'], properties: [{ key: 'оценка', op: '>', value: 9 }] }),
  { collections: ['донхуа'], keys: ['оценка'] },
);

check(
  'выдуманный тег отбрасывается',
  'найди Ваня Дмитриенко',
  search({ text: 'Ваня Дмитриенко', tags: ['музыка'] }),
  { tags: [] },
);

check(
  'общая основа не считается совпадением',
  'мистика и триллеры',
  search({ text: 'мистика', collections: ['стихи'] }),
  { collections: [] },
);

if (failed > 0) {
  console.error(`\nпровалено проверок: ${failed}`);
  process.exit(1);
}
console.log('\nразбор сказанного: все проверки пройдены');
