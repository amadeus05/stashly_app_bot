# -*- coding: utf-8 -*-
"""Проигрывает SQL, сгенерированный репозиториями, на настоящем SQLite."""
import json, sqlite3, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

data = json.load(open(HERE / 'captured.json', encoding='utf-8'))
c = sqlite3.connect(':memory:')
c.executescript(open(HERE.parent / 'migrations' / '0001_init.sql', encoding='utf-8').read())
c.execute('PRAGMA foreign_keys=ON')

def to_sqlite(sql):
    # D1 нумерует параметры ?1..?N — SQLite это понимает нативно.
    return sql

failed = 0
for i, entry in enumerate(data['log']):
    sql, binds = entry['sql'], entry.get('binds') or []
    if 'SELECT' in sql and 'INSERT' not in sql and 'UPDATE' not in sql and 'DELETE' not in sql:
        # Чистые чтения: проверяем только что они парсятся и исполняются.
        pass
    try:
        params = {str(n + 1): v for n, v in enumerate(binds)}
        c.execute(to_sqlite(sql), params if params else {})
    except Exception as e:
        failed += 1
        print(f'FAIL #{i}: {e}\n  {sql.strip()[:160]}\n  binds={binds}')

print(f'\nвыполнено {len(data["log"])} операторов, ошибок: {failed}')

print('\nсостояние БД:')
for table in ['users', 'collections', 'objects', 'properties', 'tags', 'object_tags',
              'attachments', 'search_index', 'search_dirty']:
    n = c.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]
    print(f'  {table:16} {n}')

print('\nсодержимое индекса:')
for otype, oid, content in c.execute('SELECT object_type, object_id, content FROM search_index'):
    print(f'  {otype:11} {content[:95]}')

print('\nпоиск (SQL, сгенерированный SearchRepository):')
for item in data['searchSql']:
    params = {str(n + 1): v for n, v in enumerate(item['binds'])}
    try:
        rows = c.execute(item['sql'], params).fetchall()
        found = ', '.join(f'{r[1]}<-{r[3]}' for r in rows) or 'НИЧЕГО'
        print(f'  {item["query"]!r:48} -> {found}')
    except Exception as e:
        failed += 1
        print(f'  {item["query"]!r:48} -> ОШИБКА: {e}')

sys.exit(1 if failed else 0)
