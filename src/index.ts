import { webhookCallback } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { SearchRepository } from './infrastructure/d1/search.js';
import { StateRepository } from './infrastructure/d1/state.js';
import { createBot } from './infrastructure/telegram/bot.js';

export interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
  /** Сверяется с заголовком Telegram: без него вебхук может дёрнуть кто угодно. */
  WEBHOOK_SECRET: string;
  /** Защищает /admin/*. */
  ADMIN_SECRET: string;
  /** JSON от getMe — избавляет от лишнего вызова Bot API на каждый апдейт. */
  BOT_INFO?: string;
  /** Расшифровка голосовых. Без него бот работает, просто без неё. */
  GROQ_API_TOKEN?: string;
}

function botInfoFrom(env: Env): UserFromGetMe | undefined {
  if (!env.BOT_INFO) return undefined;
  try {
    return JSON.parse(env.BOT_INFO) as UserFromGetMe;
  } catch {
    return undefined;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response('ok');
    }

    // Установка вебхука. Отдельным вызовом, а не при каждом запуске:
    // setWebhook имеет свои лимиты и не должен дёргаться на каждый апдейт.
    if (url.pathname === '/admin/set-webhook') {
      if (url.searchParams.get('secret') !== env.ADMIN_SECRET) {
        return new Response('forbidden', { status: 403 });
      }

      const target = `${url.origin}/webhook`;
      const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: target,
          secret_token: env.WEBHOOK_SECRET,
          allowed_updates: ['message', 'callback_query'],
          drop_pending_updates: true,
        }),
      });

      // Список команд в меню «/» — единственное место, где пользователь
      // может узнать о возможностях бота, не читая инструкцию.
      await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setMyCommands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commands: [
            { command: 'start', description: 'Главное меню' },
            { command: 'find', description: 'Поиск: /find небеса или /find tag:любимое' },
            { command: 'help', description: 'Как искать и сохранять' },
            { command: 'cancel', description: 'Отменить текущее действие' },
          ],
        }),
      });

      return new Response(await response.text(), {
        status: response.status,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.pathname !== '/webhook' || request.method !== 'POST') {
      return new Response('not found', { status: 404 });
    }

    // URL вебхука публичен, поэтому подлинность апдейта проверяем до того,
    // как отдать тело grammY.
    if (request.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET) {
      return new Response('forbidden', { status: 403 });
    }

    const bot = createBot(env.BOT_TOKEN, env.DB, botInfoFrom(env), env.GROQ_API_TOKEN);

    try {
      return await webhookCallback(bot, 'cloudflare-mod')(request);
    } catch (error) {
      // Вернуть не-200 значит попросить Telegram прислать апдейт заново —
      // и получить дубль ответа. Ошибку логируем, апдейт подтверждаем.
      console.error('webhook error', error);
      return new Response('ok');
    } finally {
      // Индекс дособираем после ответа, чтобы не задерживать вебхук.
      ctx.waitUntil(new SearchRepository(env.DB).flushDirty().catch(() => 0));
    }
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Страховка на случай, если воркер умер между мутацией и переиндексацией.
    ctx.waitUntil(
      (async () => {
        await new SearchRepository(env.DB).flushDirty(1000);
        await new StateRepository(env.DB).purgeExpired();
      })(),
    );
  },
};
