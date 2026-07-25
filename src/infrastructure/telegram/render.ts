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
  const lines = [`${icon} <b>${esc(label)}</b>`];

  if (detail.properties.length > 0) {
    lines.push('');
    for (const property of detail.properties) {
      lines.push(`🔹 <b>${esc(property.key)}:</b> ${esc(formatValue(property))}`);
    }
  }

  if (detail.notes.length > 0) {
    lines.push('');
    for (const note of detail.notes) {
      lines.push(`💬 ${esc(note.body ?? '')}`);
    }
  }

  if (detail.properties.length === 0 && detail.notes.length === 0) {
    lines.push('', '<i>Нет полей. Добавьте, например, «Тайминг» или «Серия».</i>');
  }

  return lines.join('\n');
}

export function renderCard(card: EntryCard): string {
  const lines: string[] = [];

  const collections = card.collections.map((c) => `${c.icon ?? '📁'} ${esc(c.name)}`).join(', ');
  lines.push(`<b>${esc(card.entry.title ?? 'Без названия')}</b>`);
  if (collections) lines.push(`<i>${collections}</i>`);

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
      lines.push(`💬 ${esc(note.body ?? '')}`);
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

export function renderHits(page: Page<SearchHit>, query: string): string {
  if (page.items.length === 0) {
    return (
      `Ничего не нашлось по запросу <code>${esc(query)}</code>.\n\n` +
      `Фильтры: <code>tag:любимое</code> <code>оценка&gt;=9</code> <code>has:фото</code> <code>раздел:донхуа</code>`
    );
  }

  const lines = [`Найдено по запросу <code>${esc(query)}</code>:`, ''];
  for (const hit of page.items) {
    const icon = HIT_ICON[hit.matchedType] ?? '📄';
    // Показываем, ГДЕ совпало: попадание в скрин не должно выглядеть
    // так же, как попадание в название записи.
    const where = hit.matchedType === 'entry' ? '' : ` <i>(${hit.snippet ? esc(hit.snippet) : 'вложение'})</i>`;
    lines.push(`${icon} ${esc(hit.entryTitle)}${where}`);
  }
  return lines.join('\n') + pageLabel(page);
}

export function renderList(page: Page<StoredObject>, title: string): string {
  if (page.items.length === 0) return `<b>${esc(title)}</b>\n\nПусто.`;
  return (
    [`<b>${esc(title)}</b>`, '', ...page.items.map((e) => `📄 ${esc(e.title ?? 'Без названия')}`)].join('\n') +
    pageLabel(page)
  );
}
