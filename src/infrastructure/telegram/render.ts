import type { Page } from '../../application/service.js';
import { formatValue } from '../../domain/property.js';
import type { EntryCard, MediaType, Property, SearchHit, StoredObject } from '../../domain/types.js';

/** Пользовательский текст идёт в parse_mode: HTML — экранируем всегда. */
export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const MEDIA_ICON: Record<MediaType, string> = {
  photo: '📷',
  video: '🎬',
  audio: '🎵',
  voice: '🎤',
  document: '📄',
  animation: '🎞',
  video_note: '📹',
  sticker: '🩹',
};

const MEDIA_LABEL: Record<MediaType, string> = {
  photo: 'Фото',
  video: 'Видео',
  audio: 'Аудио',
  voice: 'Голосовое',
  document: 'Документ',
  animation: 'Гифка',
  video_note: 'Кружок',
  sticker: 'Стикер',
};

/** Подпись под открытым вложением: его собственные свойства и заметки. */
export function renderAttachment(
  detail: { object: StoredObject; attachment: { mediaType: MediaType }; properties: Property[]; notes: StoredObject[] },
  index: number,
): string {
  const icon = MEDIA_ICON[detail.attachment.mediaType];
  const label = detail.object.title ?? `${MEDIA_LABEL[detail.attachment.mediaType]} ${index}`;
  const lines = [header(`${icon} ${label}`)];

  if (detail.properties.length > 0) {
    lines.push('');
    for (const property of detail.properties) {
      lines.push(`🔹 <b>${esc(property.key)}:</b> ${esc(formatValue(property))}`);
    }
  }

  if (detail.notes.length > 0) {
    lines.push('');
    for (const note of detail.notes) {
      lines.push(`💬 ${esc(note.body ?? '')}  <i>${shortDate(note.createdAt)}</i>`);
    }
  }

  if (detail.properties.length === 0 && detail.notes.length === 0) {
    lines.push('', '<i>Нет полей. Добавьте, например, «Тайминг» или «Серия».</i>');
  }

  return lines.join('\n');
}

export function renderCard(card: EntryCard): string {
  const lines: string[] = [];

  lines.push(header(card.entry.title ?? 'Без названия'));

  // Дерево вместо строки через точку: символы ├ и └ сами читаются как
  // «принадлежит», и каждый раздел виден отдельной ветвью.
  const branches = [
    ...card.collections.map((c) => `${c.icon ?? '📁'} ${esc(c.name)}`),
    `🕘 ${shortDate(card.entry.createdAt)}`,
  ];

  branches.forEach((branch, index) => {
    const glyph = index === branches.length - 1 ? '└' : '├';
    lines.push(`${glyph} <i>${branch}</i>`);
  });

  if (card.entry.body) {
    lines.push('', esc(card.entry.body));
  }

  if (card.properties.length > 0) {
    lines.push('');
    for (const property of card.properties) {
      lines.push(`🔹 <b>${esc(property.key)}:</b> ${esc(formatValue(property))}`);
    }
  }

  if (card.tags.length > 0) {
    lines.push('', card.tags.map((tag) => `#${esc(tag.name)}`).join(' '));
  }

  if (card.notes.length > 0) {
    lines.push('', `<b>Заметки</b>`);
    for (const note of card.notes.slice(0, 5)) {
      lines.push(`💬 ${esc(note.body ?? '')}  <i>${shortDate(note.createdAt)}</i>`);
    }
    if (card.notes.length > 5) lines.push(`<i>…ещё ${card.notes.length - 5}</i>`);
  }

  if (card.attachments.length > 0) {
    lines.push('', `<b>Вложения</b>`);
    card.attachments.slice(0, 5).forEach((item, index) => {
      const icon = MEDIA_ICON[item.attachment.mediaType];
      const meta = item.properties.map((p) => `${esc(p.key)} ${esc(formatValue(p))}`).join(' · ');
      // «без подписи» ни о чём не говорит — показываем тип и номер.
      const label = item.object.title ?? `${MEDIA_LABEL[item.attachment.mediaType]} ${index + 1}`;
      lines.push(`${icon} ${esc(label)}${meta ? ` — ${meta}` : ''}`);
    });
    if (card.attachments.length > 5) lines.push(`<i>…ещё ${card.attachments.length - 5}</i>`);
  }

  return lines.join('\n');
}

const HIT_ICON: Record<string, string> = { entry: '📄', attachment: '📎', note: '💬' };

/** Точное число страниц неизвестно — знаем только, есть ли следующая. */
function pageLabel(page: Page<unknown>): string {
  if (page.page === 0 && !page.hasMore) return '';
  return `\n\n<i>стр. ${page.page + 1}</i>`;
}

/**
 * Дата создания заметки.
 *
 * Только дата, без времени: метки хранятся в UTC, а часового пояса
 * пользователя Telegram не сообщает. Показывать «23:05» тому, у кого
 * на часах 02:05, хуже, чем не показывать время вовсе.
 */
function shortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${date.getUTCFullYear()}`;
}

/** Заголовок экрана. Цитата отделяет его от кнопок, не занимая места. */
export function header(text: string): string {
  return `<blockquote>${esc(text)}</blockquote>`;
}

export function renderHits(page: Page<SearchHit>, query: string): string {
  if (page.items.length === 0) {
    return (
      `${header(`Ничего не нашлось: ${query}`)}\n\n` +
      `Фильтры: <code>tag:любимое</code> <code>оценка&gt;=9</code> <code>has:фото</code> <code>раздел:донхуа</code>`
    );
  }

  // Названия не перечисляем — они уже на кнопках. Оставляем только то,
  // чего в кнопках нет: где именно совпало.
  const elsewhere = page.items.filter((hit) => hit.matchedType !== 'entry');
  const lines = [header(`Найдено: ${query}`)];

  if (elsewhere.length > 0) {
    lines.push('');
    for (const hit of elsewhere) {
      const icon = HIT_ICON[hit.matchedType] ?? '📄';
      const where = hit.snippet ? esc(hit.snippet) : 'вложение';
      lines.push(`${icon} <i>${esc(hit.entryTitle)} — ${where}</i>`);
    }
  }

  return lines.join('\n') + pageLabel(page);
}

export function renderList(page: Page<StoredObject>, title: string): string {
  // Перечислять записи текстом незачем: они прямо под этим на кнопках.
  if (page.items.length === 0) return `${header(title)}\n\nПусто.`;
  return header(title) + pageLabel(page);
}
