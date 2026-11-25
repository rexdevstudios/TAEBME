/**
 * app/api/agent/copilot/chat/route.ts
 *
 * Universal Conversational AI Trading & Launchpad Copilot Endpoint (Phase ED).
 * - Protected by SIWE session + Rate Limiter (20/min).
 * - Grounded in real-time Binance 24h tickers, Verified KOL Consensus, BytePlus Info Quest MCP,
 *   Launchpad deployer fees, and the user's connected Multi-Account Vaults (zero secrets).
 * - Advisory & Action-Draft only: NEVER executes trades without explicit /copilot/confirm click.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireActiveSession } from '@packages/auth/session';
import { rateLimiter } from '@packages/auth/rate-limiter';
import {
  defaultBillingDbAdapter,
  defaultKillSwitchDbAdapter,
  defaultProviderKeyVaultAdapter,
  getDbPool,
} from '@packages/shared/db-pool';
import { TOP_LIQUID_CEX_PAIRS } from '@packages/shared/market-pairs';
import { fetchAutoPilot24hTickers } from '@packages/agent/autopilot-market-feed';
import {
  computeAntiManipulationKolConsensus,
  loadVerifiedKolSignalsForSymbol,
} from '@packages/intelligence/kol-chart-overlay';
import {
  fetchBytePlusInfoQuestCatalystHint,
  generateMarketAdvisoryNote,
} from '@packages/intelligence/llm-advisory-client';
import { FeatureEngine } from '@packages/intelligence/feature-engine';
import { intelligenceCache } from '@packages/intelligence/market-data-cache';
import {
  COPILOT_PAPER_SIM_ACCOUNT,
  buildDeterministicCopilotReply,
  filterTopMoversByPercent,
  parseCopilotUserMessage,
  type CopilotConnectedAccount,
  type CopilotDeployerFeeSummary,
} from '@packages/agent/copilot-engine';

export const dynamic = 'force-dynamic';

async function loadUserConnectedAccounts(
  userId: string,
  walletAddress: string
): Promise<CopilotConnectedAccount[]> {
  const accounts: CopilotConnectedAccount[] = [];
  const pool = getDbPool();

  const [bybitKeys, bankrKeys] = await Promise.all([
    defaultProviderKeyVaultAdapter.listKeys(walletAddress, 'BYBIT').catch(() => []),
    defaultProviderKeyVaultAdapter.listKeys(walletAddress, 'BANKR').catch(() => []),
  ]);

  if (pool) {
    try {
      const binRes = await pool.query(
        `SELECT id, label, masked_api_key, environment, is_default
         FROM binance_credentials
         WHERE user_id = $1 AND is_active = true
         ORDER BY is_default DESC, created_at DESC
         LIMIT 20`,
        [userId]
      );
      for (const r of binRes.rows) {
        accounts.push({
          id: String(r.id),
          rail: 'BINANCE',
          label: String(r.label || 'Binance Spot'),
          maskedKey: String(r.masked_api_key || '****'),
          scope: String(r.environment || 'TESTNET').toUpperCase(),
          isDefault: Boolean(r.is_default),
        });
      }
    } catch {
      // non-blocking
    }
  }

  for (const k of bybitKeys) {
    accounts.push({
      id: k.id,
      rail: 'BYBIT',
      label: k.label,
      maskedKey: k.maskedKey,
      scope: String(k.chainScope || 'testnet').toUpperCase(),
      isDefault: k.isDefault,
    });
  }

  for (const k of bankrKeys) {
    accounts.push({
      id: k.id,
      rail: 'BANKR',
      label: k.label,
      maskedKey: k.maskedKey,
      scope: String(k.chainScope || 'base').toUpperCase(),
      isDefault: k.isDefault,
    });
  }

  // Always include built-in zero-risk Paper Trading Simulator account so new/FREE users can test LIMIT/MARKET drafts immediately
  accounts.push({
    ...COPILOT_PAPER_SIM_ACCOUNT,
    isDefault: accounts.filter((a) => a.rail === 'BINANCE' || a.rail === 'BYBIT').length === 0,
  });

  return accounts;
}

async function loadUserDeployerFees(userId: string): Promise<CopilotDeployerFeeSummary[]> {
  const pool = getDbPool();
  if (!pool) return [];
  try {
    const res = await pool.query(
      `SELECT tl.contract_address, tl.chain, tl.raised_amount, tl.graduation_threshold, tl.is_graduated
       FROM token_launches tl
       JOIN launch_drafts ld ON ld.id = tl.draft_id
       WHERE ld.creator_id = $1
       ORDER BY tl.published_at DESC
       LIMIT 20`,
      [userId]
    );
    return res.rows.map((r) => {
      const raised = Number(r.raised_amount || 0);
      return {
        contractAddress: String(r.contract_address || ''),
        chain: String(r.chain || 'base'),
        raisedAmount: raised,
        estimatedCreatorFee: Number((raised * 0.005).toFixed(6)),
        graduationThreshold: Number(r.graduation_threshold || 0),
        isGraduated: Boolean(r.is_graduated),
      };
    });
  } catch {
    return [];
  }
}

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for') || '127.0.0.1';
    const rateCheck = await rateLimiter.checkRateLimit(`ratelimit:agent:copilot:chat:${ip}`, 20, 60);
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { success: false, error: 'TOO_MANY_REQUESTS: Copilot rate limit exceeded', timestamp: new Date().toISOString() },
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
    const locale: 'en' | 'id' = body?.locale === 'id' ? 'id' : 'en';
    const parsed = parseCopilotUserMessage(body?.message);
    if (!parsed.valid) {
      return NextResponse.json(
        { success: false, error: parsed.error || 'INVALID_MESSAGE', timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }

    const symbols = TOP_LIQUID_CEX_PAIRS.map((p) => p.symbol);
    const pool = getDbPool();

    const [tickers, kolSignals, accounts, deployerTokens, platformCfg, activeKillSwitches, newsHint] =
      await Promise.all([
        fetchAutoPilot24hTickers(symbols).catch(() => ({})),
        loadVerifiedKolSignalsForSymbol(pool, parsed.symbol).catch(() => []),
        loadUserConnectedAccounts(session.user.userId, session.walletAddress),
        loadUserDeployerFees(session.user.userId),
        defaultBillingDbAdapter.getPlatformFeeAndRiskConfig().catch(() => null),
        defaultKillSwitchDbAdapter.getActiveKillSwitches().catch(() => []),
        parsed.kind === 'NEWS_AND_KOL' || parsed.kind === 'GENERAL_MARKET'
          ? fetchBytePlusInfoQuestCatalystHint(parsed.sanitizedMessage).catch(() => null)
          : Promise.resolve(null),
      ]);

    const kolConsensus = computeAntiManipulationKolConsensus({
      tokenSymbol: parsed.symbol,
      signals: kolSignals,
    });

    const topMovers =
      parsed.kind === 'TOP_MOVERS'
        ? filterTopMoversByPercent(tickers, parsed.minChangePct ?? 5)
        : filterTopMoversByPercent(tickers, 5).slice(0, 3);

    const deterministicReply = buildDeterministicCopilotReply({
      locale,
      intent: parsed,
      tickers,
      topMovers,
      deployerTokens,
      accounts,
      kolConsensus,
      newsHint,
    });

    // Optional BytePlus/Gemini narrative enrichment for general market/news/order queries
    let llmSummary: string | null = null;
    let llmProvider: string = 'deterministic-copilot';
    if (parsed.kind === 'NEWS_AND_KOL' || parsed.kind === 'GENERAL_MARKET' || parsed.actionDraft) {
      const signal = FeatureEngine.computeSignal(parsed.symbol, intelligenceCache, null, null, null, platformCfg?.aiFeatureWeights);
      const advisory = await generateMarketAdvisoryNote(signal, {
        symbol: parsed.symbol,
        action: parsed.side,
        suggestedQty: parsed.amountUsd,
        locale,
        thinkingMode: 'fast',
        kolConsensus,
      }).catch(() => null);
      if (advisory && advisory.provider !== 'deterministic-fallback') {
        llmSummary = `${advisory.summary} (${advisory.caution})`;
        llmProvider = advisory.provider;
      }
    }

    const reply = llmSummary ? `${deterministicReply}\n\nAI Insight: ${llmSummary}` : deterministicReply;
    const killSwitchActive = activeKillSwitches.some((ks) => ks.isActive);

    return NextResponse.json(
      {
        success: true,
        data: {
          intentKind: parsed.kind,
          reply,
          provider: llmProvider,
          symbol: parsed.symbol,
          liveHighlights: {
            topMovers: topMovers.slice(0, 6),
            deployerTokens: deployerTokens.slice(0, 5),
            kolConsensus,
            newsHint,
          },
          actionDraft: parsed.actionDraft || null,
          availableAccounts: accounts,
          riskLimits: {
            maxOrderValueUsd: platformCfg?.maxOrderValueUsd ?? 1000,
            maxDailyLossUsd: platformCfg?.maxDailyLossUsd ?? 5000,
            killSwitchActive,
          },
        },
        timestamp: new Date().toISOString(),
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || 'COPILOT_CHAT_FAILED', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}
