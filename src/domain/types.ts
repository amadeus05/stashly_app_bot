export type ObjectType = 'entry' | 'attachment' | 'note';

export type PropertyType =
  | 'text'
  | 'number'
  | 'date'
  | 'bool'
  | 'url'
  | 'select'
  | 'duration';

export type MediaType =
  | 'photo'
  | 'video'
  | 'audio'
  | 'voice'
  | 'document'
  | 'animation'
  | 'video_note'
  | 'sticker';

export interface Collection {
  id: string;
  userId: number;
  name: string;
  icon: string | null;
}

export interface StoredObject {
  id: string;
  userId: number;
  type: ObjectType;
  parentId: string | null;
  title: string | null;
  body: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Property {
  id: string;
  objectId: string;
  key: string;
  type: PropertyType;
  valueText: string | null;
  valueNum: number | null;
  valueDate: string | null;
}

export interface Attachment {
  objectId: string;
  mediaType: MediaType;
  fileId: string;
  fileUniqueId: string;
  caption: string | null;
}

export interface Tag {
  id: string;
  name: string;
}

/** Карточка записи со всем, что к ней прицеплено. */
export interface EntryCard {
  entry: StoredObject;
  collections: Collection[];
  properties: Property[];
  tags: Tag[];
  attachments: Array<{ object: StoredObject; attachment: Attachment; properties: Property[] }>;
  notes: StoredObject[];
}

/**
 * Результат поиска. FTS находит любой объект, поэтому попадание всегда
 * поднимается до корневой записи, но место попадания сохраняется —
 * иначе пользователь, искавший "Ван Линь", получит карточку вместо скрина.
 */
export interface SearchHit {
  entryId: string;
  entryTitle: string;
  matchedObjectId: string;
  matchedType: ObjectType;
  snippet: string;
}
