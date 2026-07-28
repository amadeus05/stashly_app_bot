-- 0002_field_defs.sql
-- Справочник полей: заранее заведённые поля со списком значений.
--
-- До сих пор поля существовали только по факту заполнения, а подсказки
-- строились из истории. Этого хватает, пока не нужно задать структуру
-- заранее и не печатать одни и те же значения руками.

-- Таблицы templates / template_fields / collection_templates заводились
-- под другую идею — «шаблон записи как набор полей». Она не понадобилась,
-- а справочник отдельных полей устроен иначе. Пустые таблицы удаляем,
-- чтобы не гадать потом, какая из двух моделей рабочая.
DROP TABLE IF EXISTS collection_templates;
DROP TABLE IF EXISTS template_fields;
DROP TABLE IF EXISTS templates;

CREATE TABLE field_defs (
  id            TEXT    PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key           TEXT    NOT NULL,
  key_norm      TEXT    NOT NULL,

  -- NULL — тип не задан: определится по первому введённому значению.
  -- Заданный тип включает проверку ввода.
  type          TEXT             CHECK (type IS NULL OR type IN
                  ('text','number','date','bool','url','select','duration')),

  -- NULL — поле общее, доступно везде. Иначе привязано к разделу.
  collection_id TEXT             REFERENCES collections(id) ON DELETE CASCADE,

  -- Где предлагать: у записей, у вложений или везде. Без этого «Тайминг»
  -- начал бы предлагаться на карточке записи, а «Озвучка» — на скрине.
  target        TEXT    NOT NULL DEFAULT 'entry'
                  CHECK (target IN ('entry','attachment','any')),

  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- Имя уникально в пределах своей области: общее «Статус» и «Статус»
-- раздела «Донхуа» — разные поля и мешать друг другу не должны.
-- COALESCE вместо NULL: в SQLite NULL не равен сам себе, и без него
-- уникальность общих полей не работала бы вовсе.
CREATE UNIQUE INDEX idx_field_defs_scope
  ON field_defs(user_id, key_norm, COALESCE(collection_id, ''), target);

CREATE INDEX idx_field_defs_user ON field_defs(user_id, key);
CREATE INDEX idx_field_defs_collection ON field_defs(collection_id);

-- Готовые значения. Нет строк — поле со свободным вводом, как раньше.
CREATE TABLE field_options (
  id           TEXT    PRIMARY KEY,
  field_def_id TEXT    NOT NULL REFERENCES field_defs(id) ON DELETE CASCADE,
  value        TEXT    NOT NULL,
  value_norm   TEXT    NOT NULL,
  position     INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE UNIQUE INDEX idx_field_options_value ON field_options(field_def_id, value_norm);
CREATE INDEX idx_field_options_order ON field_options(field_def_id, position);

-- Настройки экрана справочника. Выставлять фильтр и сортировку заново
-- при каждом заходе — раздражает сильнее, чем отсутствие фильтра.
ALTER TABLE users ADD COLUMN fields_sort TEXT NOT NULL DEFAULT 'asc'
  CHECK (fields_sort IN ('asc', 'desc'));

-- NULL — показывать все, 'global' — только общие, иначе id раздела.
ALTER TABLE users ADD COLUMN fields_filter TEXT;
