/**
 * app/api/telegram/webhook/route.ts
 *
 * Vercel-Native Stateless Telegram Bot Webhook (Batch V3).
 * Replaces legacy grammy long-polling daemon in src/.
 * - Strictly validates X-Telegram-Bot-Api-Secret-Token against TELEGRAM_WEBHOOK_SECRET (min 16 chars).
 * - Rate-limited via Upstash Redis (graceful fallback).
 * - 100% read-only SSOT queries, zero private keys, zero persistent polling loops.
 */

import { NextRequest, NextResponse } from 'next/server';
import { rateLimiter } from '@packages/auth/rate-limiter';
import { defaultDraftDbAdapter } from '@packages/shared/db-pool';
import { fetchOnChainTokenSecurity, isValidEvmAddress } from '@packages/intelligence/onchain-insider-guard';
import { fetchFreeWalletProfile } from '@packages/intelligence/free-wallet-intelligence';
import {
  formatTelegramTokenSafetyReply,
  formatTelegramWalletRiskReply,
} from '@packages/notifications/webhook-dispatcher';

export const dynamic = 'force-dynamic';

function isTelegramWebhookAuthorized(req: NextRequest): boolean {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!expectedSecret || expectedSecret.length < 16) return false;
  const headerSecret = req.headers.get('x-telegram-bot-api-secret-token')?.trim();
  return Boolean(headerSecret && headerSecret === expectedSecret);
}

async function sendTelegramReply(chatId: number | string, text: string): Promise<boolean> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  if (!isTelegramWebhookAuthorized(req)) {
    return NextResponse.json(
      { success: false, error: 'UNAUTHORIZED: Invalid X-Telegram-Bot-Api-Secret-Token header', timestamp: new Date().toISOString() },
      { status: 401 }
    );
  }

  const ip = req.headers.get('x-forwarded-for') || 'telegram';
  const rateCheck = await rateLimiter.checkRateLimit(`ratelimit:telegram:${ip}`, 60, 60);
  if (!rateCheck.allowed) {
    return NextResponse.json(
      { success: false, error: 'TOO_MANY_REQUESTS', timestamp: new Date().toISOString() },
      { status: 429 }
    );
  }

  try {
    const update = await req.json().catch(() => ({}));
    const message = update?.message;
    const chatId = message?.chat?.id;
    const text = typeof message?.text === 'string' ? message.text.trim() : '';

    if (!chatId || !text) {
      return NextResponse.json({ success: true, data: { handled: false }, timestamp: new Date().toISOString() });
    }

    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    let reply = 'POOLNET Launchpad & AI Scanner Bot.\nCommands:\n/start · /status · /tokens\n/safety <0xContract> [chainId]\n/wallet <0xAddress>';

    if (cmd === '/start' || cmd === '/status') {
      reply =
        'POOLNET SocialFi & Launchpad is OPERATIONAL on Vercel + Neon PostgreSQL SSOT.\n' +
        'Commands:\n• /tokens — Live launches\n• /safety <0xContract> [8453] — Anti-Honeypot & Insider Scan ($0)\n• /wallet <0xAddress> — Wallet Risk Audit ($0)\n' +
        'Visit https://pndigi.site/launchpad';
    } else if (cmd === '/tokens') {
      const launches = await defaultDraftDbAdapter.getActiveTokenLaunches().catch(() => []);
      if (launches.length === 0) {
        reply = 'No active token launches registered yet.';
      } else {
        const lines = launches.slice(0, 5).map((t: any) => `- $${t.ticker || 'TOKEN'} (${t.name || 'Launch'}) [${t.chain || 'base'}]`);
        reply = `Active RTrader Launches (${launches.length}):\n${lines.join('\n')}`;
      }
    } else if (cmd === '/safety') {
      const targetAddr = (parts[1] || '').trim();
      const targetChain = Number(parts[2] || 8453);
      if (!isValidEvmAddress(targetAddr)) {
        reply = 'Usage: /safety <0xTokenContract> [chainId]\nExample: /safety 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 8453';
      } else {
        const report = await fetchOnChainTokenSecurity({
          address: targetAddr,
          chainId: Number.isInteger(targetChain) && targetChain > 0 ? targetChain : 8453,
        });
        reply = formatTelegramTokenSafetyReply(report);
      }
    } else if (cmd === '/wallet') {
      const targetAddr = (parts[1] || '').trim();
      if (!isValidEvmAddress(targetAddr)) {
        reply = 'Usage: /wallet <0xWalletAddress>\nExample: /wallet 0x0000000000001ff3684f28c67538d4d072c22734';
      } else {
        const profile = await fetchFreeWalletProfile({ address: targetAddr, chainId: 8453 });
        reply = formatTelegramWalletRiskReply(profile);
      }
    }

    const delivered = await sendTelegramReply(chatId, reply);
    return NextResponse.json({
      success: true,
      data: { handled: true, command: cmd, delivered, reply },
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'TELEGRAM_WEBHOOK_ERROR', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}
