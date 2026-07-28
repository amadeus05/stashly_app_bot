import { nowIso } from '../core/time.js';
import type { ScheduleRule } from '../domain/schedule.js';
import { nextRun } from '../domain/schedule.js';
import type { Reminder } from '../infrastructure/d1/reminders.js';
import { ReminderRepository } from '../infrastructure/d1/reminders.js';

/**
 * Рассылка напоминаний.
 *
 * Живёт отдельно от бота: крон работает без входящего сообщения, а значит
 * без grammY-контекста. Отправляем через Bot API напрямую.
 */
export class ReminderService {
  private readonly repo: ReminderRepository;

  constructor(
    db: D1Database,
    private readonly botToken: string,
  ) {
    this.repo = new ReminderRepository(db);
  }

  /** Следующее срабатывание: повтор переносится, разовое гаснет. */
  private static nextAfter(rule: ScheduleRule, firedAt: number): string | null {
    const at = nextRun(rule, firedAt);
    return at ? new Date(at).toISOString() : null;
  }

  private text(reminder: Reminder): string {
    const lines = ['⏰ <b>Напоминание</b>'];

    if (reminder.entryTitle) lines.push('', `📄 <b>${escapeHtml(reminder.entryTitle)}</b>`);
    if (reminder.text) lines.push('', `💬 ${escapeHtml(reminder.text)}`);

    if (!reminder.entryTitle && !reminder.text) lines.push('', '<i>без описания</i>');
    return lines.join('\n');
  }

  private keyboard(reminder: Reminder) {
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];

    if (reminder.objectId) {
      rows.push([
        { text: '📄 Открыть', callback_data: `e:${reminder.objectId}` },
        { text: '😴 Через час', callback_data: `rs:${reminder.id}` },
      ]);
    } else {
      rows.push([{ text: '😴 Через час', callback_data: `rs:${reminder.id}` }]);
    }

    rows.push([{ text: '✖️ Больше не напоминать', callback_data: `rx:${reminder.id}` }]);
    return { inline_keyboard: rows };
  }

  /**
   * Отправляет всё, чей срок наступил.
   *
   * Возвращает число отправленных — крон логирует его, чтобы отставание
   * было видно, а не пряталось.
   */
  async deliverDue(): Promise<number> {
    const due = await this.repo.due(nowIso());
    if (due.length === 0) return 0;

    const firedAt = Date.now();
    let sent = 0;

    for (const reminder of due) {
      const ok = await this.send(reminder);

      if (ok) {
        sent += 1;
        await this.repo.advance(reminder.id, ReminderService.nextAfter(reminder.rule, firedAt));
        continue;
      }

      // Не доставили — гасим это напоминание, чтобы не долбиться каждую
      // минуту. Чаще всего причина одна: бота заблокировали.
      await this.repo.advance(reminder.id, null);
    }

    return sent;
  }

  private async send(reminder: Reminder): Promise<boolean> {
    try {
      const response = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: reminder.userId,
          text: this.text(reminder),
          parse_mode: 'HTML',
          reply_markup: this.keyboard(reminder),
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        console.error('reminder send failed', reminder.id, response.status, await response.text());
        return false;
      }

      return true;
    } catch (error) {
      console.error('reminder send error', reminder.id, error);
      return false;
    }
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
