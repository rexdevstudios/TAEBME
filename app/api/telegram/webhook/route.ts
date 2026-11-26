/**
 * app/api/telegram/webhook/route.ts
 *
 * Vercel-Native Stateless Telegram Bot Webhook (Batch V3).
 * Replaces legacy grammy long-polling daemon in src/.
 * - Strictly validates X-Telegram-Bot-Api-Secret-Token against TELEGRAM_WEBHOOK_SECRET (min 16 chars).
 * - Rate-limited via Upstash Redis (graceful fallback).
 * - 100% read-only SSOT queries, zero private keys, zero persistent polling loops.
 */

import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { rateLimiter } from '@packages/auth/rate-limiter';
import { defaultDraftDbAdapter, defaultBillingDbAdapter, defaultBountyDbAdapter } from '@packages/shared/db-pool';
import {
  appendWhiteLabelTelegramFooter,
  resolvePartnerByTelegramChatId,
} from '@packages/billing/whitelabel-partner';
import { fetchOnChainTokenSecurity, isValidEvmAddress } from '@packages/intelligence/onchain-insider-guard';
import { fetchFreeWalletProfile } from '@packages/intelligence/free-wallet-intelligence';
import {
  formatTelegramAirdropListReply,
  formatTelegramTokenSafetyReply,
  formatTelegramWalletRiskReply,
} from '@packages/notifications/webhook-dispatcher';
import {
  GENESIS_SBT_SUPPLY_CAP,
  formatWeeklyGenesisDigestMessage,
} from '@packages/billing/genesis-sbt';
import { PROP_CHALLENGE_RULES } from '@packages/trading/prop-challenge';

export const dynamic = 'force-dynamic';

function isTelegramWebhookAuthorized(req: NextRequest): boolean {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!expectedSecret || expectedSecret.length < 16) return false;
  const headerSecret = req.headers.get('x-telegram-bot-api-secret-token')?.trim();
  if (!headerSecret) return false;
  const a = crypto.createHash('sha256').update(headerSecret).digest();
  const b = crypto.createHash('sha256').update(expectedSecret).digest();
  return crypto.timingSafeEqual(a, b);
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
    const cmd = parts[0].toLowerCase().split('@')[0];
    let reply =
      'POOLNET Launchpad & AI Scanner Bot.\nCommands:\n' +
      '/start · /status · /airdrop · /genesis · /prop · /tokens · /chatid\n' +
      '/safety <0xContract> [chainId]\n' +
      '/wallet <0xAddress>';

    if (cmd === '/start' || cmd === '/status') {
      reply =
        'POOLNET SocialFi & Launchpad is OPERATIONAL on Vercel + Neon PostgreSQL SSOT.\n' +
        'Commands:\n' +
        '• /airdrop — Active Airdrops, KOL Bounties & Free-Mint Genesis SBT\n' +
        '• /genesis — Live Free-Mint Genesis SBT & Referral Leaderboard\n' +
        '• /prop — POOLNET Prop Trading Cup Rules & Verified Traders\n' +
        '• /tokens — Live launches\n' +
        '• /safety <0xContract> [8453] — Anti-Honeypot & Insider Scan ($0)\n' +
        '• /wallet <0xAddress> — Wallet Risk Audit ($0)\n' +
        '• /chatid — Show current Telegram Chat ID (Admin/Partner helper)\n' +
        'Visit https://pndigi.site';
    } else if (cmd === '/airdrop' || cmd === '/bounties') {
      const [campaigns, genesisState] = await Promise.all([
        defaultBountyDbAdapter.listCampaigns().catch(() => []),
        defaultBillingDbAdapter
          .getGenesisSbtState()
          .catch(() => ({ totalMinted: 0, userPass: null, leaderboard: [] })),
      ]);
      reply = formatTelegramAirdropListReply({
        campaigns,
        genesisMinted: genesisState.totalMinted,
        genesisCap: GENESIS_SBT_SUPPLY_CAP,
        siteOrigin: 'https://pndigi.site',
      });
    } else if (cmd === '/genesis') {
      const [genesisState, propState] = await Promise.all([
        defaultBillingDbAdapter.getGenesisSbtState().catch(() => ({ totalMinted: 0, userPass: null, leaderboard: [] })),
        defaultBillingDbAdapter.getPropChallengeState().catch(() => ({ totalChallenges: 0, verifiedTradersCount: 0, leaderboard: [], activeChallenge: null })),
      ]);
      reply = formatWeeklyGenesisDigestMessage({
        totalMinted: genesisState.totalMinted,
        supplyCap: GENESIS_SBT_SUPPLY_CAP,
        leaderboard: genesisState.leaderboard,
        verifiedPropTraders: propState.verifiedTradersCount,
        siteOrigin: 'https://pndigi.site',
      });
    } else if (cmd === '/prop') {
      const propState = await defaultBillingDbAdapter
        .getPropChallengeState()
        .catch(() => ({ totalChallenges: 0, verifiedTradersCount: 0, leaderboard: [], activeChallenge: null }));
      reply =
        `POOLNET Proof-of-Skill Prop Trading Cup\n` +
        `• Virtual Equity: $${PROP_CHALLENGE_RULES.startingEquityUsd.toLocaleString()}\n` +
        `• Profit Target: +${PROP_CHALLENGE_RULES.profitTargetPct}% (min ${PROP_CHALLENGE_RULES.minTradingDays} trading days)\n` +
        `• Risk Limits: Max ${PROP_CHALLENGE_RULES.maxDailyLossPct}% daily loss · ${PROP_CHALLENGE_RULES.maxTotalDrawdownPct}% total drawdown\n` +
        `• Entry: ${PROP_CHALLENGE_RULES.entryFeeCredits} cr or ${PROP_CHALLENGE_RULES.entryFeeEth} ETH · Pass Reward: +${PROP_CHALLENGE_RULES.passRewardCredits} cr\n` +
        `• Active/Total Entries: ${propState.totalChallenges} · Verified Traders: ${propState.verifiedTradersCount}\n` +
        `Enter now: https://pndigi.site/prop`;
    } else if (cmd === '/chatid') {
      const chatType = String(message?.chat?.type || 'unknown');
      const chatTitle = message?.chat?.title ? ` (${String(message.chat.title)})` : '';
      reply = `Telegram Chat ID: ${chatId}\nType: ${chatType}${chatTitle}\nUse this ID for TELEGRAM_DIGEST_CHAT_ID or White-Label B2B Partner config in /billing Admin Tab.`;
    } else if (cmd === '/tokens') {
      const launches = await defaultDraftDbAdapter.getActiveTokenLaunches().catch(() => []);
      if (launches.length === 0) {
        reply = 'No active token launches registered yet.';
      } else {
        const lines = launches.slice(0, 5).map((t: any) => `- $${t.ticker || 'TOKEN'} (${t.name || 'Launch'}) [${t.chain || 'base'}]`);
        reply = `Active POOLNET Launches (${launches.length}):\n${lines.join('\n')}`;
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

    // Phase DI: Automatic White-Label B2B Partner Branding per Telegram Group chatId
    const partners = await defaultBillingDbAdapter.getWhiteLabelPartners().catch(() => []);
    const matchedPartner = resolvePartnerByTelegramChatId(partners, chatId);
    const finalReply = appendWhiteLabelTelegramFooter(reply, matchedPartner);

    const delivered = await sendTelegramReply(chatId, finalReply);
    return NextResponse.json({
      success: true,
      data: { handled: true, command: cmd, delivered, reply: finalReply, partnerSlug: matchedPartner?.slug || null },
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'TELEGRAM_WEBHOOK_ERROR', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}
