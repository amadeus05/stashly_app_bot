-- 0003_tag_scope.sql
-- Привязка тега к разделу — для порядка в списке выбора.
--
-- В отличие от полей, имя тега остаётся уникальным на пользователя:
-- два разных тега «любимое» сделали бы фильтр «tag:любимое»
-- двусмысленным, а искать по тегу должно быть однозначно.
-- Раздел здесь — принадлежность, а не отдельное пространство имён.

ALTER TABLE tags ADD COLUMN collection_id TEXT REFERENCES collections(id) ON DELETE SET NULL;

CREATE INDEX idx_tags_collection ON tags(collection_id);

-- Настройки экрана тегов — как у полей: выставлять фильтр заново при
-- каждом заходе раздражает сильнее, чем его отсутствие.
ALTER TABLE users ADD COLUMN tags_sort TEXT NOT NULL DEFAULT 'asc'
  CHECK (tags_sort IN ('asc', 'desc'));

ALTER TABLE users ADD COLUMN tags_filter TEXT;
