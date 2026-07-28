/**
 * Расшифровка голосовых через Groq Whisper.
 *
 * Единственная часть проекта, зависящая от внешнего сервиса: он может
 * тормозить, падать и упираться в лимит. Поэтому наружу отдаётся либо
 * текст, либо null — и ни одна ошибка отсюда не должна ронять обработку
 * сообщения. Голосовое сохранится в любом случае, просто без расшифровки.
 */

/** Whisper справляется и с русским, и с английским без указания языка. */
const MODEL = 'whisper-large-v3-turbo';

/** Больше ждать нет смысла: пользователь уже смотрит на экран. */
const TIMEOUT_MS = 20_000;

/** Голосовые заметки короткие; на длинных дешевле промолчать. */
const MAX_BYTES = 8 * 1024 * 1024;

export interface TranscribeDeps {
  botToken: string;
  groqToken: string | undefined;
}

/** Путь к файлу у Telegram живёт около часа — берём его прямо перед скачиванием. */
async function downloadFile(botToken: string, fileId: string): Promise<Blob | null> {
  const info = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!info.ok) return null;

  const payload = (await info.json()) as { ok: boolean; result?: { file_path?: string; file_size?: number } };
  const path = payload.result?.file_path;
  if (!payload.ok || !path) return null;
  if ((payload.result?.file_size ?? 0) > MAX_BYTES) return null;

  const file = await fetch(`https://api.telegram.org/file/bot${botToken}/${path}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  return file.ok ? await file.blob() : null;
}

/**
 * Возвращает расшифровку или null.
 *
 * null — это не ошибка, а «не получилось»: нет ключа, сервис отказал,
 * тишина в записи. Вызывающий просто не сохраняет текст.
 */
export async function transcribe(deps: TranscribeDeps, fileId: string): Promise<string | null> {
  if (!deps.groqToken) return null;

  try {
    const audio = await downloadFile(deps.botToken, fileId);
    if (!audio) return null;

    const form = new FormData();
    // Имя файла обязательно: без расширения сервис не определит формат.
    form.append('file', audio, 'voice.ogg');
    form.append('model', MODEL);
    form.append('response_format', 'json');
    // Нулевая температура: нам нужна расшифровка, а не пересказ.
    form.append('temperature', '0');

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: `Bearer ${deps.groqToken}` },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      console.error('transcribe failed', response.status, await response.text());
      return null;
    }

    const result = (await response.json()) as { text?: string };
    const text = result.text?.trim();

    // Whisper на тишине выдаёт пустую строку или одиночный знак препинания.
    return text && text.length > 1 ? text : null;
  } catch (error) {
    console.error('transcribe error', error);
    return null;
  }
}
