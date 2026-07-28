import { inMinutes, nowIso } from '../../core/time.js';

/**
 * Состояние пошагового ввода.
 *
 * На Workers нет памяти между запросами: каждый апдейт — холодный вызов.
 * Поэтому «Название поля?» → «Значение?» обязано жить в БД, иначе мастер
 * развалится между двумя сообщениями пользователя.
 */
export type DialogState =
  | 'idle'
  | 'collection:name'
  | 'entry:title'
  | 'entry:collection'
  | 'property:key'
  | 'property:value'
  | 'note:text'
  | 'tag:name'
  | 'search:query'
  | 'field:key'
  | 'field:type'
  | 'field:scope'
  | 'field:options'
  | 'field:rename'
  | 'option:rename';

export interface Dialog {
  state: DialogState;
  payload: Record<string, string>;
}

const IDLE: Dialog = { state: 'idle', payload: {} };

/** Брошенный мастер не должен ловить сообщения через сутки. */
const TTL_MINUTES = 30;

export class StateRepository {
  constructor(private readonly db: D1Database) {}

  async get(userId: number): Promise<Dialog> {
    const row = await this.db
      .prepare(`SELECT state, payload, expires_at FROM user_state WHERE user_id = ?1`)
      .bind(userId)
      .first<{ state: DialogState; payload: string; expires_at: string | null }>();

    if (!row) return IDLE;
    if (row.expires_at && row.expires_at < nowIso()) return IDLE;

    try {
      return { state: row.state, payload: JSON.parse(row.payload) as Record<string, string> };
    } catch {
      // Битый payload — не повод ронять апдейт: просто начинаем заново.
      return IDLE;
    }
  }

  async set(userId: number, state: DialogState, payload: Record<string, string> = {}): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO user_state(user_id, state, payload, expires_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(user_id) DO UPDATE SET
           state      = excluded.state,
           payload    = excluded.payload,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`,
      )
      .bind(userId, state, JSON.stringify(payload), inMinutes(TTL_MINUTES), nowIso())
      .run();
  }

  async clear(userId: number): Promise<void> {
    await this.db.prepare(`DELETE FROM user_state WHERE user_id = ?1`).bind(userId).run();
  }

  async purgeExpired(): Promise<void> {
    await this.db.prepare(`DELETE FROM user_state WHERE expires_at < ?1`).bind(nowIso()).run();
  }
}
