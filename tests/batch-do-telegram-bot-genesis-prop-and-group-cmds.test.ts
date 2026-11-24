/**
 * Unit Suite #82 — Phase DO:
 * Telegram Bot Interactive /genesis, /prop, /chatid & Group @botname Command Parsing Fix.
 */
import { describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { POST as postTelegramWebhook } from '../app/api/telegram/webhook/route';

function makeWebhookReq(text: string, secret: string, chatId: number = -1001234567890, chatType: string = 'supergroup') {
  return new NextRequest('https://pndigi.site/api/telegram/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': secret,
    },
    body: JSON.stringify({
      message: {
        chat: { id: chatId, type: chatType, title: 'POOLNET Test Group' },
        text,
      },
    }),
  });
}

describe('Phase DO — Telegram Bot /genesis, /prop, /chatid & Group @botname Suffix Fix', () => {
  const SECRET = 'telegram-test-secret-phase-do-123456';

  test('strips @Moonshiller_bot suffix cleanly in group chats', async () => {
    const prevSec = process.env.TELEGRAM_WEBHOOK_SECRET;
    const prevTok = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    process.env.TELEGRAM_BOT_TOKEN = '';
    try {
      const res = await postTelegramWebhook(makeWebhookReq('/status@Moonshiller_bot', SECRET));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.command).toBe('/status');
      expect(json.data.reply).toContain('OPERATIONAL');
      expect(json.data.reply).toContain('/genesis');
      expect(json.data.reply).toContain('/prop');
    } finally {
      if (prevSec !== undefined) process.env.TELEGRAM_WEBHOOK_SECRET = prevSec;
      else delete process.env.TELEGRAM_WEBHOOK_SECRET;
      if (prevTok !== undefined) process.env.TELEGRAM_BOT_TOKEN = prevTok;
      else delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });

  test('handles /genesis, /prop, and /chatid commands cleanly', async () => {
    const prevSec = process.env.TELEGRAM_WEBHOOK_SECRET;
    const prevTok = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    process.env.TELEGRAM_BOT_TOKEN = '';
    try {
      const genRes = await postTelegramWebhook(makeWebhookReq('/genesis@Moonshiller_bot', SECRET));
      expect(genRes.status).toBe(200);
      const genJson = await genRes.json();
      expect(genJson.data.command).toBe('/genesis');
      expect(genJson.data.reply).toContain('POOLNET Weekly Genesis Sprint Digest');

      const propRes = await postTelegramWebhook(makeWebhookReq('/prop', SECRET));
      expect(propRes.status).toBe(200);
      const propJson = await propRes.json();
      expect(propJson.data.command).toBe('/prop');
      expect(propJson.data.reply).toContain('POOLNET Proof-of-Skill Prop Trading Cup');
      expect(propJson.data.reply).toContain('https://pndigi.site/prop');

      const idRes = await postTelegramWebhook(makeWebhookReq('/chatid', SECRET, -1009988776655, 'supergroup'));
      expect(idRes.status).toBe(200);
      const idJson = await idRes.json();
      expect(idJson.data.command).toBe('/chatid');
      expect(idJson.data.reply).toContain('-1009988776655');
      expect(idJson.data.reply).toContain('supergroup');
    } finally {
      if (prevSec !== undefined) process.env.TELEGRAM_WEBHOOK_SECRET = prevSec;
      else delete process.env.TELEGRAM_WEBHOOK_SECRET;
      if (prevTok !== undefined) process.env.TELEGRAM_BOT_TOKEN = prevTok;
      else delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });
});
