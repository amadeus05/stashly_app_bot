import { newId } from '../../core/id.js';
import type { ScheduleRule } from '../../domain/schedule.js';

export interface Reminder {
  id: string;
  userId: number;
  objectId: string | null;
  entryTitle: string | null;
  text: string | null;
  rule: ScheduleRule;
  nextAt: string;
  active: boolean;
}

interface ReminderRow {
  id: string;
  user_id: number;
  object_id: string | null;
  entry_title: string | null;
  text: string | null;
  rule: string;
  next_at: string;
  active: number;
}

/** Правило старой формы: один час на все дни сразу. */
interface LegacyWeekly {
  kind: 'weekly';
  days: number[];
  hour: number;
  minute: number;
  offset: number;
}

function parseRule(raw: string): ScheduleRule {
  try {
    const value = JSON.parse(raw) as ScheduleRule | LegacyWeekly;
    if (value.kind === 'every' && Number.isFinite(value.minutes)) return value;

    if (value.kind === 'weekly') {
      if ('slots' in value && Array.isArray(value.slots) && value.slots.length > 0) return value;

      // Правила, сохранённые до появления времени у каждого дня. Читаем их
      // как есть, а не теряем: у пользователя они уже стоят и должны
      // продолжать приходить.
      const legacy = value as LegacyWeekly;
      if (Array.isArray(legacy.days) && legacy.days.length > 0) {
        return {
          kind: 'weekly',
          offset: legacy.offset ?? 0,
          slots: legacy.days.map((day) => ({ day, hour: legacy.hour ?? 9, minute: legacy.minute ?? 0 })),
        };
      }
    }

    return { kind: 'once' };
  } catch {
    return { kind: 'once' };
  }
}

const toReminder = (row: ReminderRow): Reminder => ({
  id: row.id,
  userId: row.user_id,
  objectId: row.object_id,
  entryTitle: row.entry_title,
  text: row.text,
  rule: parseRule(row.rule),
  nextAt: row.next_at,
  active: row.active === 1,
});

const SELECT = `
  SELECT r.id, r.user_id, r.object_id, r.text, r.rule, r.next_at, r.active,
         o.title AS entry_title
  FROM reminders r
  LEFT JOIN objects o ON o.id = r.object_id`;

export class ReminderRepository {
  constructor(private readonly db: D1Database) {}

  async create(
    userId: number,
    objectId: string | null,
    text: string | null,
    nextAt: string,
    rule: ScheduleRule,
  ): Promise<string> {
    const id = newId();
    await this.db
      .prepare(
        `INSERT INTO reminders(id, user_id, object_id, text, rule, next_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(id, userId, objectId, text, JSON.stringify(rule), nextAt)
      .run();

    return id;
  }

  /**
   * Что пора отправить.
   *
   * Лимит не для красоты: воркер на бесплатном тарифе может сделать
   * 50 исходящих запросов за вызов. Остаток подождёт следующей минуты —
   * это лучше, чем потерять часть напоминаний молча.
   */
  async due(nowIso: string, limit = 30): Promise<Reminder[]> {
    const { results } = await this.db
      .prepare(`${SELECT} WHERE r.active = 1 AND r.next_at <= ?1 ORDER BY r.next_at LIMIT ?2`)
      .bind(nowIso, limit)
      .all<ReminderRow>();

    return results.map(toReminder);
  }

  async list(userId: number): Promise<Reminder[]> {
    const { results } = await this.db
      .prepare(`${SELECT} WHERE r.user_id = ?1 ORDER BY r.active DESC, r.next_at`)
      .bind(userId)
      .all<ReminderRow>();

    return results.map(toReminder);
  }

  async find(userId: number, id: string): Promise<Reminder | null> {
    const row = await this.db
      .prepare(`${SELECT} WHERE r.user_id = ?1 AND r.id = ?2`)
      .bind(userId, id)
      .first<ReminderRow>();

    return row ? toReminder(row) : null;
  }

  /** После срабатывания: повтор переносится, разовое гаснет. */
  async advance(id: string, nextAt: string | null): Promise<void> {
    await this.db
      .prepare(
        `UPDATE reminders
         SET fired_count = fired_count + 1,
             next_at = COALESCE(?2, next_at),
             active = CASE WHEN ?2 IS NULL THEN 0 ELSE active END
         WHERE id = ?1`,
      )
      .bind(id, nextAt)
      .run();
  }

  /** Отложить: «через час» с самого уведомления. */
  async reschedule(userId: number, id: string, nextAt: string): Promise<void> {
    await this.db
      .prepare(`UPDATE reminders SET next_at = ?3, active = 1 WHERE id = ?1 AND user_id = ?2`)
      .bind(id, userId, nextAt)
      .run();
  }

  async setActive(userId: number, id: string, active: boolean): Promise<void> {
    await this.db
      .prepare(`UPDATE reminders SET active = ?3 WHERE id = ?1 AND user_id = ?2`)
      .bind(id, userId, active ? 1 : 0)
      .run();
  }

  async setText(userId: number, id: string, text: string): Promise<void> {
    await this.db
      .prepare(`UPDATE reminders SET text = ?3 WHERE id = ?1 AND user_id = ?2`)
      .bind(id, userId, text.trim().slice(0, 500))
      .run();
  }

  async delete(userId: number, id: string): Promise<void> {
    await this.db.prepare(`DELETE FROM reminders WHERE id = ?1 AND user_id = ?2`).bind(id, userId).run();
  }

  /** Блокировка бота — не повод долбиться вечно. */
  async deactivateAll(userId: number): Promise<void> {
    await this.db.prepare(`UPDATE reminders SET active = 0 WHERE user_id = ?1`).bind(userId).run();
  }

  // --- часовой пояс --------------------------------------------------------

  async timezone(userId: number): Promise<number | null> {
    const row = await this.db
      .prepare(`SELECT tz_offset FROM users WHERE id = ?1`)
      .bind(userId)
      .first<{ tz_offset: number | null }>();

    return row?.tz_offset ?? null;
  }

  async setTimezone(userId: number, offsetMinutes: number): Promise<void> {
    await this.db
      .prepare(`UPDATE users SET tz_offset = ?2 WHERE id = ?1`)
      .bind(userId, offsetMinutes)
      .run();
  }
}
