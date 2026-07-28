-- 0005_reminders.sql
-- Напоминания.
--
-- Крон читает единственный столбец — next_at. Всё разнообразие расписаний
-- живёт в JSON и вычисляется в коде: заводить по таблице на каждый вид
-- расписания незачем, а индекс по времени нужен ровно один.

CREATE TABLE reminders (
  id          TEXT    PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Запись, о которой напоминаем. NULL — напоминание само по себе.
  -- Удалили запись — уходит и напоминание о ней.
  object_id   TEXT             REFERENCES objects(id) ON DELETE CASCADE,

  -- Приписка от руки: «досмотреть до 40 серии».
  text        TEXT,

  -- {"kind":"once"} либо {"kind":"every","minutes":N}
  rule        TEXT    NOT NULL DEFAULT '{"kind":"once"}',

  -- Когда сработает. UTC, ISO-8601 — сортируется лексикографически.
  next_at     TEXT    NOT NULL,

  -- Пауза: напоминание, которое временно мешает, обычно не хотят терять.
  active      INTEGER NOT NULL DEFAULT 1,

  fired_count INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- Единственный запрос крона: активные, чей срок наступил.
CREATE INDEX idx_reminders_due ON reminders(next_at) WHERE active = 1;
CREATE INDEX idx_reminders_user ON reminders(user_id, next_at);

-- Смещение часового пояса в минутах. Telegram часовой пояс не сообщает,
-- а «каждый день в 9 утра» без него исполнить невозможно.
-- NULL — не спрашивали; спросим при первом напоминании со временем.
ALTER TABLE users ADD COLUMN tz_offset INTEGER;
