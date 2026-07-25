-- 0001_init.sql
-- Ядро note_keeper: универсальная объектная модель поверх D1 (SQLite).
--
-- Главный принцип: движок ничего не знает о предметной области.
-- Есть объекты (запись / вложение / заметка), у каждого могут быть
-- свойства, теги и дочерние объекты. Домен ("донхуа", "рыбалка")
-- живёт в данных пользователя, а не в схеме.

-- PRAGMA foreign_keys здесь намеренно нет: D1 включает внешние ключи сам,
-- а PRAGMA в миграции ломает apply.

-- ---------------------------------------------------------------------------
-- Пользователи
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id           INTEGER PRIMARY KEY,          -- telegram user id
  username     TEXT,
  first_name   TEXT,
  language     TEXT    NOT NULL DEFAULT 'ru',
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- ---------------------------------------------------------------------------
-- Коллекции (разделы). Запись может лежать в нескольких сразу.
-- ---------------------------------------------------------------------------

CREATE TABLE collections (
  id           TEXT    PRIMARY KEY,          -- uuid
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL,
  name_norm    TEXT    NOT NULL,             -- lower(name), для collection:донхуа
  icon         TEXT,                         -- эмодзи
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE UNIQUE INDEX idx_collections_user_name ON collections(user_id, name_norm);

-- ---------------------------------------------------------------------------
-- Объекты. Одна таблица на запись / вложение / заметку.
--
-- type = 'entry'      -> карточка, parent_id IS NULL
--        'attachment' -> медиа, parent_id = entry
--        'note'       -> заметка/цитата, parent_id = entry ИЛИ attachment
--
-- Иерархия ограничена приложением: entry -> {attachment, note} -> note.
-- Схема допускает больше, но глубже мы не идём.
-- ---------------------------------------------------------------------------

CREATE TABLE objects (
  id           TEXT    PRIMARY KEY,          -- uuid
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         TEXT    NOT NULL CHECK (type IN ('entry', 'attachment', 'note')),
  parent_id    TEXT             REFERENCES objects(id) ON DELETE CASCADE,
  title        TEXT,                         -- обязателен для entry, опционален у остальных
  body         TEXT,                         -- текст заметки / описание записи
  position     INTEGER NOT NULL DEFAULT 0,   -- порядок среди сиблингов
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  CHECK (type <> 'entry' OR parent_id IS NULL),
  CHECK (type =  'entry' OR parent_id IS NOT NULL)
) STRICT;

CREATE INDEX idx_objects_user_type   ON objects(user_id, type, created_at DESC);
CREATE INDEX idx_objects_parent      ON objects(parent_id, position);
CREATE INDEX idx_objects_user_recent ON objects(user_id, updated_at DESC) WHERE type = 'entry';

-- Связь записи с коллекциями (many-to-many).
CREATE TABLE object_collections (
  object_id     TEXT NOT NULL REFERENCES objects(id)     ON DELETE CASCADE,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  PRIMARY KEY (object_id, collection_id)
) STRICT;

CREATE INDEX idx_object_collections_collection ON object_collections(collection_id);

-- ---------------------------------------------------------------------------
-- Медиа. Только file_id — сами файлы хранит Telegram.
-- ---------------------------------------------------------------------------

CREATE TABLE attachments (
  object_id        TEXT PRIMARY KEY REFERENCES objects(id) ON DELETE CASCADE,
  media_type       TEXT NOT NULL CHECK (media_type IN
                     ('photo','video','audio','voice','document','animation','video_note','sticker')),
  file_id          TEXT NOT NULL,            -- для повторной отправки; привязан к токену бота
  file_unique_id   TEXT NOT NULL,            -- стабильный, для дедупликации; отправить по нему НЕЛЬЗЯ
  mime_type        TEXT,
  file_size        INTEGER,
  duration         INTEGER,                  -- сек, для audio/voice/video
  width            INTEGER,
  height           INTEGER,
  caption          TEXT
) STRICT;

CREATE INDEX idx_attachments_unique_id ON attachments(file_unique_id);

-- ---------------------------------------------------------------------------
-- Свойства. EAV, но с типизированными колонками значения —
-- иначе rating>=9 сравнивало бы строки и '10' оказалось бы меньше '9'.
--
-- Заполнена ровно одна из value_* согласно type.
-- ---------------------------------------------------------------------------

CREATE TABLE properties (
  id           TEXT    PRIMARY KEY,
  object_id    TEXT    NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,  -- денорм. ради фильтров
  key          TEXT    NOT NULL,             -- как ввёл пользователь: "Озвучка"
  key_norm     TEXT    NOT NULL,             -- lower(key): "озвучка", для voice:anistar
  type         TEXT    NOT NULL CHECK (type IN
                 ('text','number','date','bool','url','select','duration')),
  value_text   TEXT,                         -- text / url / select
  value_num    REAL,                         -- number / bool (0|1) / duration (секунды)
  value_date   TEXT,                         -- ISO-8601 UTC; сортируется лексикографически
  position     INTEGER NOT NULL DEFAULT 0,

  CHECK (
    (type IN ('text','url','select') AND value_text IS NOT NULL AND value_num IS NULL AND value_date IS NULL) OR
    (type IN ('number','bool','duration') AND value_num IS NOT NULL AND value_date IS NULL) OR
    (type = 'date' AND value_date IS NOT NULL AND value_num IS NULL)
  )
) STRICT;

CREATE UNIQUE INDEX idx_properties_object_key ON properties(object_id, key_norm);
CREATE INDEX idx_properties_filter_num  ON properties(user_id, key_norm, value_num);
CREATE INDEX idx_properties_filter_date ON properties(user_id, key_norm, value_date);
CREATE INDEX idx_properties_filter_text ON properties(user_id, key_norm, value_text);

-- ---------------------------------------------------------------------------
-- Теги
-- ---------------------------------------------------------------------------

CREATE TABLE tags (
  id           TEXT    PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL,
  name_norm    TEXT    NOT NULL,
  color        TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE UNIQUE INDEX idx_tags_user_name ON tags(user_id, name_norm);

CREATE TABLE object_tags (
  object_id TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  tag_id    TEXT NOT NULL REFERENCES tags(id)    ON DELETE CASCADE,
  PRIMARY KEY (object_id, tag_id)
) STRICT;

CREATE INDEX idx_object_tags_tag ON object_tags(tag_id);

-- ---------------------------------------------------------------------------
-- Шаблоны коллекций: набор предзаполняемых полей.
-- Движок их не интерпретирует — это подсказки для UI при создании записи.
-- ---------------------------------------------------------------------------

CREATE TABLE templates (
  id           TEXT    PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL,
  target       TEXT    NOT NULL CHECK (target IN ('entry','attachment')),
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE template_fields (
  id           TEXT    PRIMARY KEY,
  template_id  TEXT    NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  key          TEXT    NOT NULL,
  type         TEXT    NOT NULL,
  options      TEXT,                          -- JSON-массив вариантов для select
  required     INTEGER NOT NULL DEFAULT 0,
  position     INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX idx_template_fields_template ON template_fields(template_id, position);

-- Шаблон по умолчанию для коллекции.
CREATE TABLE collection_templates (
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  template_id   TEXT NOT NULL REFERENCES templates(id)   ON DELETE CASCADE,
  PRIMARY KEY (collection_id, template_id)
) STRICT;

-- ---------------------------------------------------------------------------
-- Состояние диалога.
-- На Workers нет памяти между запросами: любой мастер ввода
-- ("Название поля?" -> "Значение?") обязан жить здесь.
-- ---------------------------------------------------------------------------

CREATE TABLE user_state (
  user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state        TEXT    NOT NULL,             -- 'idle' | 'awaiting_entry_title' | ...
  payload      TEXT    NOT NULL DEFAULT '{}',-- JSON: контекст шага
  expires_at   TEXT,                         -- незавершённые мастера подчищает cron
  updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX idx_user_state_expires ON user_state(expires_at) WHERE expires_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Полнотекстовый поиск.
--
-- Одна строка индекса на объект. content — склейка title + body + значений
-- свойств + тегов + caption вложения.
--
-- Синхронизация: триггеры НЕ пересобирают content (в чистом SQL это
-- хрупко и медленно), а лишь помечают объект грязным. Приложение
-- разгребает очередь тем же batch'ем, что и запись; cron подчищает хвосты.
-- ---------------------------------------------------------------------------

CREATE VIRTUAL TABLE search_index USING fts5(
  content,
  object_id   UNINDEXED,
  user_id     UNINDEXED,
  object_type UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE search_dirty (
  object_id  TEXT PRIMARY KEY,
  queued_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- Объект изменился напрямую.
CREATE TRIGGER trg_dirty_objects_ai AFTER INSERT ON objects BEGIN
  INSERT INTO search_dirty(object_id) VALUES (new.id) ON CONFLICT DO NOTHING;
END;

CREATE TRIGGER trg_dirty_objects_au AFTER UPDATE ON objects BEGIN
  INSERT INTO search_dirty(object_id) VALUES (new.id) ON CONFLICT DO NOTHING;
END;

CREATE TRIGGER trg_dirty_objects_ad AFTER DELETE ON objects BEGIN
  DELETE FROM search_index WHERE object_id = old.id;
  DELETE FROM search_dirty WHERE object_id = old.id;
END;

-- Изменилось свойство -> грязным становится его объект.
CREATE TRIGGER trg_dirty_properties_ai AFTER INSERT ON properties BEGIN
  INSERT INTO search_dirty(object_id) VALUES (new.object_id) ON CONFLICT DO NOTHING;
END;

CREATE TRIGGER trg_dirty_properties_au AFTER UPDATE ON properties BEGIN
  INSERT INTO search_dirty(object_id) VALUES (new.object_id) ON CONFLICT DO NOTHING;
END;

CREATE TRIGGER trg_dirty_properties_ad AFTER DELETE ON properties BEGIN
  INSERT INTO search_dirty(object_id)
  SELECT old.object_id WHERE EXISTS (SELECT 1 FROM objects WHERE id = old.object_id)
  ON CONFLICT DO NOTHING;
END;

CREATE TRIGGER trg_dirty_object_tags_ai AFTER INSERT ON object_tags BEGIN
  INSERT INTO search_dirty(object_id) VALUES (new.object_id) ON CONFLICT DO NOTHING;
END;

CREATE TRIGGER trg_dirty_object_tags_ad AFTER DELETE ON object_tags BEGIN
  INSERT INTO search_dirty(object_id)
  SELECT old.object_id WHERE EXISTS (SELECT 1 FROM objects WHERE id = old.object_id)
  ON CONFLICT DO NOTHING;
END;

CREATE TRIGGER trg_dirty_attachments_ai AFTER INSERT ON attachments BEGIN
  INSERT INTO search_dirty(object_id) VALUES (new.object_id) ON CONFLICT DO NOTHING;
END;

CREATE TRIGGER trg_dirty_attachments_au AFTER UPDATE ON attachments BEGIN
  INSERT INTO search_dirty(object_id) VALUES (new.object_id) ON CONFLICT DO NOTHING;
END;

-- Переименование тега делает грязными все помеченные им объекты.
CREATE TRIGGER trg_dirty_tags_au AFTER UPDATE OF name ON tags BEGIN
  INSERT INTO search_dirty(object_id)
  SELECT object_id FROM object_tags WHERE tag_id = new.id
  ON CONFLICT DO NOTHING;
END;
