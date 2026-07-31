import { nowIso } from '../../core/time.js';

export class UserRepository {
  constructor(private readonly db: D1Database) {}

  /** Создаёт пользователя при первом контакте, иначе обновляет профиль. */
  async ensure(id: number, username: string | null, firstName: string | null): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO users(id, username, first_name)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET
           username   = excluded.username,
           first_name = excluded.first_name,
           updated_at = ?4`,
      )
      .bind(id, username, firstName, nowIso())
      .run();
  }

  /** Идентификатор экрана, который бот переписывает вместо новых сообщений. */
  async anchor(userId: number): Promise<number | null> {
    const row = await this.db
      .prepare(`SELECT anchor_msg_id FROM users WHERE id = ?1`)
      .bind(userId)
      .first<{ anchor_msg_id: number | null }>();

    return row?.anchor_msg_id ?? null;
  }

  async setAnchor(userId: number, messageId: number | null): Promise<void> {
    await this.db
      .prepare(`UPDATE users SET anchor_msg_id = ?2 WHERE id = ?1`)
      .bind(userId, messageId)
      .run();
  }

  /**
   * Путь до текущего экрана: последний элемент — то, что человек видит.
   *
   * Битый JSON не должен ломать навигацию — считаем, что истории нет.
   */
  async nav(userId: number): Promise<string[]> {
    const row = await this.db
      .prepare(`SELECT nav FROM users WHERE id = ?1`)
      .bind(userId)
      .first<{ nav: string | null }>();

    if (!row?.nav) return [];

    try {
      const parsed: unknown = JSON.parse(row.nav);
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }

  async setNav(userId: number, path: string[]): Promise<void> {
    await this.db
      .prepare(`UPDATE users SET nav = ?2 WHERE id = ?1`)
      .bind(userId, JSON.stringify(path))
      .run();
  }
}
