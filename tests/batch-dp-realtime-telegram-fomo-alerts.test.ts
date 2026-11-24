/**
 * Unit Suite #83 — Phase DP:
 * Real-Time Public Telegram FOMO Alerts (Genesis SBT Mint & Prop Cup Pass).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  notifyPublicTelegramChannelBestEffort,
  resolvePublicTelegramDigestUrl,
} from '../packages/notifications/webhook-dispatcher';

describe('Phase DP — Real-Time Public Telegram Channel Broadcaster', () => {
  test('resolvePublicTelegramDigestUrl prioritizes explicit URL then botToken+chatId then null', () => {
    const prevExp = process.env.GENESIS_DIGEST_WEBHOOK_URL;
    const prevTok = process.env.TELEGRAM_BOT_TOKEN;
    const prevChat = process.env.TELEGRAM_DIGEST_CHAT_ID;
    try {
      delete process.env.GENESIS_DIGEST_WEBHOOK_URL;
      delete process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.TELEGRAM_DIGEST_CHAT_ID;
      expect(resolvePublicTelegramDigestUrl()).toBeNull();

      process.env.TELEGRAM_BOT_TOKEN = '123456:ABCDEF';
      process.env.TELEGRAM_DIGEST_CHAT_ID = '6193729849';
      expect(resolvePublicTelegramDigestUrl()).toBe(
        'https://api.telegram.org/bot123456:ABCDEF/sendMessage?chat_id=6193729849'
      );

      process.env.GENESIS_DIGEST_WEBHOOK_URL = 'https://discord.com/api/webhooks/123/abc';
      expect(resolvePublicTelegramDigestUrl()).toBe('https://discord.com/api/webhooks/123/abc');
    } finally {
      if (prevExp !== undefined) process.env.GENESIS_DIGEST_WEBHOOK_URL = prevExp;
      else delete process.env.GENESIS_DIGEST_WEBHOOK_URL;
      if (prevTok !== undefined) process.env.TELEGRAM_BOT_TOKEN = prevTok;
      else delete process.env.TELEGRAM_BOT_TOKEN;
      if (prevChat !== undefined) process.env.TELEGRAM_DIGEST_CHAT_ID = prevChat;
      else delete process.env.TELEGRAM_DIGEST_CHAT_ID;
    }
  });

  test('notifyPublicTelegramChannelBestEffort is a clean no-op when unconfigured and never throws on error', async () => {
    const prevExp = process.env.GENESIS_DIGEST_WEBHOOK_URL;
    const prevTok = process.env.TELEGRAM_BOT_TOKEN;
    const prevChat = process.env.TELEGRAM_DIGEST_CHAT_ID;
    try {
      delete process.env.GENESIS_DIGEST_WEBHOOK_URL;
      delete process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.TELEGRAM_DIGEST_CHAT_ID;

      const noop = await notifyPublicTelegramChannelBestEffort({
        event: 'GENESIS_SBT_MINTED',
        title: 'Test',
        message: 'No-op test',
      });
      expect(noop.attempted).toBe(false);
      expect(noop.delivered).toBe(false);

      process.env.TELEGRAM_BOT_TOKEN = '123456:ABCDEF';
      process.env.TELEGRAM_DIGEST_CHAT_ID = '6193729849';

      const okRes = await notifyPublicTelegramChannelBestEffort(
        {
          event: 'GENESIS_SBT_MINTED',
          title: 'Genesis #1',
          message: 'Minted #1',
        },
        (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch
      );
      expect(okRes.attempted).toBe(true);
      expect(okRes.delivered).toBe(true);

      const errRes = await notifyPublicTelegramChannelBestEffort(
        {
          event: 'PROP_CHALLENGE_PASSED',
          title: 'Prop Pass',
          message: 'Passed',
        },
        (async () => {
          throw new Error('simulated network outage');
        }) as unknown as typeof fetch
      );
      expect(errRes.attempted).toBe(true);
      expect(errRes.delivered).toBe(false);
    } finally {
      if (prevExp !== undefined) process.env.GENESIS_DIGEST_WEBHOOK_URL = prevExp;
      else delete process.env.GENESIS_DIGEST_WEBHOOK_URL;
      if (prevTok !== undefined) process.env.TELEGRAM_BOT_TOKEN = prevTok;
      else delete process.env.TELEGRAM_BOT_TOKEN;
      if (prevChat !== undefined) process.env.TELEGRAM_DIGEST_CHAT_ID = prevChat;
      else delete process.env.TELEGRAM_DIGEST_CHAT_ID;
    }
  });

  test('genesis-sbt, prop/challenge, and genesis-digest reuse shared public Telegram broadcaster', () => {
    const root = join(import.meta.dir, '..');
    const sbt = readFileSync(join(root, 'app/api/gamefi/genesis-sbt/route.ts'), 'utf8');
    expect(sbt).toContain('notifyPublicTelegramChannelBestEffort');
    expect(sbt).toContain("'GENESIS_SBT_MINTED'");

    const prop = readFileSync(join(root, 'app/api/prop/challenge/route.ts'), 'utf8');
    expect(prop).toContain('notifyPublicTelegramChannelBestEffort');
    expect(prop).toContain("'PROP_CHALLENGE_PASSED'");

    const cron = readFileSync(join(root, 'app/api/cron/genesis-digest/route.ts'), 'utf8');
    expect(cron).toContain('resolvePublicTelegramDigestUrl');
  });
});
