/**
 * app/api/kol/callout/route.ts
 *
 * Verified KOL Chart Callout API (Phase FI).
 * - POST: Fail-closed SIWE authenticated endpoint restricted to Verified KOLs
 *         (kol_profiles.is_verified = true & trust_score >= 65 & social handle).
 * - Enforces 1 callout per KOL per token per 24h (anti-spam guardrail).
 * - Persists into existing Neon PostgreSQL `scraped_documents` table (domain = 'kol_callout')
 *   with zero DDL migrations, immediately appearing on /token/[chain]/[address] and /trading charts.
 */

import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { requireActiveSession } from '@packages/auth/session';
import { rateLimiter } from '@packages/auth/rate-limiter';
import { getDbPool } from '@packages/shared/db-pool';
import {
  isVerifiedKol,
  validateKolCalloutInput,
} from '@packages/intelligence/kol-chart-overlay';
import { notifyPublicTelegramChannelBestEffort } from '@packages/notifications/webhook-dispatcher';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for') || '127.0.0.1';
    const rl = await rateLimiter.checkRateLimit(`ratelimit:kol:callout:${ip}`, 10, 60);
    if (!rl.allowed) {
      return NextResponse.json(
        { success: false, error: 'TOO_MANY_REQUESTS: Callout rate limit exceeded', timestamp: new Date().toISOString() },
        { status: 429 }
      );
    }

    let session;
    try {
      session = await requireActiveSession(req);
    } catch (authErr: unknown) {
      const msg = authErr instanceof Error ? authErr.message : String(authErr);
      const isForbidden = msg.includes('AUTH_ACCOUNT_');
      return NextResponse.json(
        { success: false, error: isForbidden ? `FORBIDDEN: ${msg}` : `UNAUTHORIZED: ${msg}`, timestamp: new Date().toISOString() },
        { status: isForbidden ? 403 : 401 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const check = validateKolCalloutInput(body);
    if (!check.ok || !check.sanitized) {
      return NextResponse.json(
        { success: false, error: check.error || 'INVALID_CALLOUT_INPUT', timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }

    const pool = getDbPool();
    if (!pool) {
      return NextResponse.json(
        { success: false, error: 'DB_UNAVAILABLE: PostgreSQL SSOT pool is not connected', timestamp: new Date().toISOString() },
        { status: 503 }
      );
    }

    // Resolve verified KOL profile for authenticated wallet
    const kolRes = await pool.query(
      `SELECT kp.id, kp.twitter_handle, kp.trust_score, kp.is_verified, w.address AS wallet_address
       FROM wallets w
       JOIN kol_profiles kp ON kp.user_id = w.user_id
       WHERE LOWER(w.address) = LOWER($1)
       LIMIT 1`,
      [session.walletAddress]
    );

    const kolRow = kolRes.rows[0];
    const verified = kolRow
      ? isVerifiedKol({
          walletAddress: String(kolRow.wallet_address),
          twitterHandle: kolRow.twitter_handle,
          trustScore: Number(kolRow.trust_score ?? 0),
          isVerified: kolRow.is_verified === false ? false : undefined,
        })
      : { verified: false, tier: 'UNVERIFIED' as const, handle: '' };

    if (!kolRow || !verified.verified) {
      return NextResponse.json(
        {
          success: false,
          error: 'FORBIDDEN: KOL_VERIFICATION_REQUIRED — Only Verified KOLs (trustScore >= 65 with linked social handle) may post chart callouts.',
          timestamp: new Date().toISOString(),
        },
        { status: 403 }
      );
    }

    const data = check.sanitized;
    const normAddr = (data.tokenAddress || '').toLowerCase();

    // Anti-spam guardrail: max 1 callout per KOL per token per 24h
    const dupCheck = await pool.query(
      `SELECT id
       FROM scraped_documents
       WHERE domain = 'kol_callout'
         AND LOWER(COALESCE(extracted_metadata->>'kolWallet', '')) = LOWER($1)
         AND (
           ($2 <> '' AND LOWER(COALESCE(extracted_metadata->>'tokenAddress', '')) = $2)
           OR ($2 = '' AND UPPER(COALESCE(extracted_metadata->>'symbol', '')) = UPPER($3))
         )
         AND scraped_at >= NOW() - INTERVAL '24 hours'
       LIMIT 1`,
      [session.walletAddress, normAddr, data.symbol]
    );

    if (dupCheck.rows.length > 0) {
      return NextResponse.json(
        {
          success: false,
          error: 'CALLOUT_COOLDOWN_24H: You already posted a verified callout for this token within the last 24 hours.',
          timestamp: new Date().toISOString(),
        },
        { status: 429 }
      );
    }

    const id = crypto.randomUUID();
    const targetUrl =
      data.tweetUrl ||
      (data.tokenAddress
        ? `https://pndigi.site/token/${encodeURIComponent(data.chain)}/${encodeURIComponent(data.tokenAddress)}`
        : `https://pndigi.site/trading?symbol=${encodeURIComponent(data.symbol)}`);

    const metadata = {
      symbol: data.symbol,
      tokenAddress: data.tokenAddress || null,
      chain: data.chain,
      side: data.side,
      price: data.price ?? null,
      tweetUrl: data.tweetUrl || null,
      kolWallet: session.walletAddress.toLowerCase(),
      kolHandle: verified.handle,
      trustScore: Number(kolRow.trust_score ?? 0),
      kolTier: verified.tier,
      isVerified: true,
    };

    await pool.query(
      `INSERT INTO scraped_documents (id, target_url, domain, raw_content, markdown_content, extracted_metadata, scraped_at)
       VALUES ($1::uuid, $2, 'kol_callout', $3, $3, $4::jsonb, NOW())`,
      [id, targetUrl, data.quoteText, JSON.stringify(metadata)]
    );

    const chartUrl = data.tokenAddress
      ? `https://pndigi.site/token/${encodeURIComponent(data.chain)}/${encodeURIComponent(data.tokenAddress)}`
      : `https://pndigi.site/trading?symbol=${encodeURIComponent(data.symbol)}`;

    await notifyPublicTelegramChannelBestEffort({
      event: 'KOL_CALLOUT_PINNED',
      title: `${verified.handle} (${verified.tier} KOL) pinned ${data.side} Callout on $${data.symbol}`,
      message: `"${data.quoteText}"\nChart & Live Callout: ${chartUrl}`,
      metadata: {
        symbol: data.symbol,
        side: data.side,
        kolTier: verified.tier,
        chain: data.chain,
      },
      buttons: [
        { text: 'Inspect Chart & Callout →', url: chartUrl },
        ...(data.tweetUrl ? [{ text: 'View Tweet →', url: data.tweetUrl }] : []),
      ],
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          id,
          ...metadata,
          quoteText: data.quoteText,
        },
        timestamp: new Date().toISOString(),
      },
      { status: 201 }
    );
  } catch (err: unknown) {
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : 'KOL_CALLOUT_ERROR',
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
