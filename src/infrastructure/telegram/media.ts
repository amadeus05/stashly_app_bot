import type { Message } from 'grammy/types';
import type { MediaType } from '../../domain/types.js';
import type { NewMedia } from '../d1/entries.js';

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

/**
 * Название для записи, создаваемой из присланного медиа.
 * Подпись важнее типа: "Первый бой" полезнее, чем "Фото".
 */
export function titleForMedia(media: NewMedia): string {
  const caption = media.caption?.trim();
  if (caption) return caption.slice(0, 120);
  return `${MEDIA_LABEL[media.mediaType]} от ${new Date().toLocaleDateString('ru-RU')}`;
}

/**
 * Достаёт из сообщения медиа в виде, пригодном для хранения.
 *
 * Сам файл не скачиваем: храним только file_id, файл остаётся у Telegram.
 * file_id привязан к токену бота — при смене токена ссылки станут мёртвыми,
 * восстановить их будет неоткуда.
 */
export function extractMedia(message: Message): NewMedia | null {
  const caption = message.caption ?? null;

  if (message.photo && message.photo.length > 0) {
    // Последний элемент — максимальное разрешение.
    const photo = message.photo[message.photo.length - 1]!;
    return {
      mediaType: 'photo',
      fileId: photo.file_id,
      fileUniqueId: photo.file_unique_id,
      fileSize: photo.file_size ?? null,
      width: photo.width,
      height: photo.height,
      caption,
    };
  }

  if (message.video) {
    return {
      mediaType: 'video',
      fileId: message.video.file_id,
      fileUniqueId: message.video.file_unique_id,
      mimeType: message.video.mime_type ?? null,
      fileSize: message.video.file_size ?? null,
      duration: message.video.duration,
      width: message.video.width,
      height: message.video.height,
      caption,
    };
  }

  if (message.voice) {
    return {
      mediaType: 'voice',
      fileId: message.voice.file_id,
      fileUniqueId: message.voice.file_unique_id,
      mimeType: message.voice.mime_type ?? null,
      fileSize: message.voice.file_size ?? null,
      duration: message.voice.duration,
      caption,
    };
  }

  if (message.audio) {
    return {
      mediaType: 'audio',
      fileId: message.audio.file_id,
      fileUniqueId: message.audio.file_unique_id,
      mimeType: message.audio.mime_type ?? null,
      fileSize: message.audio.file_size ?? null,
      duration: message.audio.duration,
      caption: caption ?? message.audio.title ?? null,
    };
  }

  if (message.animation) {
    return {
      mediaType: 'animation',
      fileId: message.animation.file_id,
      fileUniqueId: message.animation.file_unique_id,
      mimeType: message.animation.mime_type ?? null,
      fileSize: message.animation.file_size ?? null,
      duration: message.animation.duration,
      caption,
    };
  }

  if (message.video_note) {
    return {
      mediaType: 'video_note',
      fileId: message.video_note.file_id,
      fileUniqueId: message.video_note.file_unique_id,
      fileSize: message.video_note.file_size ?? null,
      duration: message.video_note.duration,
      caption,
    };
  }

  if (message.document) {
    return {
      mediaType: 'document',
      fileId: message.document.file_id,
      fileUniqueId: message.document.file_unique_id,
      mimeType: message.document.mime_type ?? null,
      fileSize: message.document.file_size ?? null,
      caption: caption ?? message.document.file_name ?? null,
    };
  }

  if (message.sticker) {
    return {
      mediaType: 'sticker',
      fileId: message.sticker.file_id,
      fileUniqueId: message.sticker.file_unique_id,
      fileSize: message.sticker.file_size ?? null,
      caption: message.sticker.emoji ?? null,
    };
  }

  return null;
}
