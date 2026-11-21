/**
 * scripts/test-simulation-suite.ts
 *
 * Unified Offline E2E Simulation Suite (Zero Live DB / Zero External API Cost).
 * Validates end-to-end cross-module invariants across Phases O–AF in a single run:
 *   1. BYOK LLM Exclusive Tier Gate (TRADER/AGENT) + Whitelisted Models + Zero-Token Verifier
 *   2. Custom Agent Skills + ERC-4337/7715 Session Allowance Non-Custodial Guard
 *   3. Trading Risk Gate + 24h Exposure Clamping + Kill-Switch Enforcement
 *   4. Outbound Webhook Alerts (ORDER_APPROVED / DAILY_LOSS_WARNING / TOKEN_DEPLOYED) + SSRF Guard
 *   5. Soft-Freeze Downgrade (Zero Data Loss) & Permanent Capacity Add-On Recovery
 */

import {
  SubscriptionsEngine,
  annotateKeysWithQuotaStatus,
  computeEffectiveUserRiskLimits,
  computeEffectiveVaultCapacity,
} from '../packages/billing/subscriptions-engine';
import {
  resolveByokLlmModel,
  generateMarketAdvisoryNote,
  verifyByokLlmKeyLive,
} from '../packages/intelligence/llm-advisory-client';
import { buildAgentActionCards } from '../packages/agent/skill-registry';
import { validateSessionAllowanceSpec } from '../packages/agent/session-allowance';
import { TradingRiskGate, compute24hRiskExposure } from '../packages/trading/risk-gate';
import { notifyUserWebhookBestEffort } from '../packages/notifications/webhook-dispatcher';
import { ProviderRegistry } from '../packages/providers/registry';

let passed = 0;
let failed = 0;

function assert(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed += 1;
  } else {
    console.error(`  ✗ FAILED: ${label}`);
    failed += 1;
  }
}

async function runSimulationSuite() {
  console.log('================================================================');
  console.log('  UNIFIED E2E SIMULATION SUITE (PHASES O–AF · ZERO-COST LOCAL)  ');
  console.log('================================================================');

  // -------------------------------------------------------------------------
  // SCENARIO 1: BYOK LLM Tier Gate, Anthropic Adapter & Zero-Token Verifier
  // -------------------------------------------------------------------------
  console.log('\n--- [SCENARIO 1: BYOK LLM Exclusive Tier Gate & Anthropic Model Selector] ---');
  assert(SubscriptionsEngine.getPlanCapacities('FREE').maxLlmKeys === 0, 'FREE tier locked to 0 BYOK LLM keys');
  assert(SubscriptionsEngine.getPlanCapacities('CREATOR').maxLlmKeys === 0, 'CREATOR tier locked to 0 BYOK LLM keys');
  assert(SubscriptionsEngine.getPlanCapacities('TRADER').maxLlmKeys === 3, 'TRADER tier unlocks 3 BYOK LLM keys');
  assert(SubscriptionsEngine.getPlanCapacities('AGENT').maxLlmKeys === 5, 'AGENT tier unlocks 5 BYOK LLM keys');
  assert(resolveByokLlmModel('ANTHROPIC').id === 'claude-3-5-sonnet-latest', 'Anthropic defaults to balanced Claude 3.5 Sonnet');
  assert(resolveByokLlmModel('ANTHROPIC', 'claude-opus-4-20250514').id === 'claude-opus-4-20250514', 'Anthropic allows whitelisted Opus 4 deep mode');
  assert(resolveByokLlmModel('ANTHROPIC', 'malicious-model').id === 'claude-3-5-sonnet-latest', 'Unknown model safely falls back to default');
  assert(ProviderRegistry.getById('ANTHROPIC')?.status === 'LIVE', 'ProviderRegistry lists ANTHROPIC as LIVE');

  const verifyPing = await verifyByokLlmKeyLive({
    provider: 'ANTHROPIC',
    apiKey: 'sk-ant-sim-key-999',
    fetchImpl: (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch,
  });
  assert(verifyPing.connected === true && verifyPing.statusCode === 200, 'Zero-token live verifier succeeds on HTTP 200');

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              summary: 'BTCUSDT breakout supported by strong volume and low counterparty risk.',
              caution: 'Respect slippage cap and personal daily loss limit before signing.',
            }),
          },
        ],
      }),
      { status: 200 }
    )) as typeof fetch;
  try {
    const note = await generateMarketAdvisoryNote(
      {
        symbol: 'BTCUSDT',
        computedConfidenceScore: 0.84,
        rationale: 'Breakout confirmed',
        riskFlags: [],
        inputs: { webSentiment: 'BULLISH', counterpartyRisk: 'LOW', marketVolatility: 'NORMAL', volumeAnomaly: false },
        computedAt: new Date().toISOString(),
      },
      {
        symbol: 'BTCUSDT',
        action: 'BUY',
        suggestedQty: 0.2,
        byokLlm: { provider: 'ANTHROPIC', apiKey: 'sk-ant-sim-key-999', model: 'claude-3-5-sonnet-latest' },
      }
    );
    assert(note.provider === 'byok-anthropic' && note.model === 'claude-3-5-sonnet-latest', 'BYOK Anthropic advisory returns validated JSON note');
  } finally {
    globalThis.fetch = origFetch;
  }

  // -------------------------------------------------------------------------
  // SCENARIO 2: Custom Agent Skills & Non-Custodial ERC-4337/7715 Guard
  // -------------------------------------------------------------------------
  console.log('\n--- [SCENARIO 2: Custom Agent Skills & Non-Custodial Session Allowance] ---');
  const cards = buildAgentActionCards({
    skills: ['SKILL_CEX_TRADE', 'SKILL_DEX_SWAP', 'SKILL_TOKEN_DEPLOY', 'SKILL_NFT_MINT'],
    symbol: 'ETHUSDT',
    action: 'BUY',
    quantity: 1,
    agentName: 'Alpha Sniper',
  });
  assert(cards.length === 4, 'buildAgentActionCards emits 4 modular non-custodial action cards');

  const allowance = validateSessionAllowanceSpec(
    {
      delegateAddress: '0x1111111111111111111111111111111111111111',
      chainId: 8453,
      dailySpendCapUsd: 99999,
      expiresAtIso: new Date(Date.now() + 3 * 86400_000).toISOString(),
      allowedContracts: ['0x4200000000000000000000000000000000000006'],
      allowedActions: ['SWAP_DEX', 'MINT_NFT'],
    },
    'TRADER'
  );
  assert(allowance.effectiveDailySpendCapUsd === 10000, 'Session allowance clamps daily spend cap to TRADER tier ($10,000)');

  let rejectedPk = false;
  try {
    validateSessionAllowanceSpec(
      {
        delegateAddress: '0x' + 'ab'.repeat(32),
        chainId: 8453,
        dailySpendCapUsd: 100,
        expiresAtIso: new Date(Date.now() + 86400_000).toISOString(),
        allowedContracts: ['0x4200000000000000000000000000000000000006'],
        allowedActions: ['SWAP_DEX'],
      },
      'TRADER'
    );
  } catch {
    rejectedPk = true;
  }
  assert(rejectedPk, 'Session allowance strictly rejects 64-hex private key (AGENTS.md Rule 3)');

  // -------------------------------------------------------------------------
  // SCENARIO 3: Risk Gate + 24h Exposure + Kill-Switch Enforcement
  // -------------------------------------------------------------------------
  console.log('\n--- [SCENARIO 3: Risk Gate, 24h Exposure Clamping & Kill-Switch] ---');
  const effLimits = computeEffectiveUserRiskLimits({
    planId: 'TRADER',
    userPolicy: {
      userId: 'sim-user',
      maxOrderValueUsd: 5000,
      maxDailyLossUsd: 400,
      maxSlippagePct: 1.5,
      allowedSymbols: ['BTCUSDT', 'ETHUSDT'],
    },
    platformGlobal: { maxOrderValueUsd: 10000, maxDailyLossUsd: 1000, maxSlippagePct: 3.0 },
  });
  assert(effLimits.maxOrderValueUsd === 5000 && effLimits.maxDailyLossUsd === 400, 'User personal risk limits clamp strictly below tier & global caps');

  const exposure = compute24hRiskExposure({
    fills: [
      { side: 'BUY', quoteValueUsd: 1000, status: 'FILLED' },
      { side: 'SELL', quoteValueUsd: 500, status: 'FILLED' },
    ],
    openIntentCount: 1,
  });
  assert(exposure.currentDailyLossUsd === 500 && exposure.currentOpenPositions === 1, '24h exposure computes deterministic realized daily loss ($500) & open intents (1)');

  const blockedByLoss = TradingRiskGate.evaluateIntent(
    { userId: 'sim-user', stage: 'LIVE', symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.01, price: 30000 },
    { maxOrderValueUsd: effLimits.maxOrderValueUsd, maxDailyLossUsd: effLimits.maxDailyLossUsd, currentDailyLossUsd: exposure.currentDailyLossUsd, maxOpenPositions: 5, currentOpenPositions: 1 },
    { planId: 'TRADER', hasLiveTrading: true },
    []
  );
  assert(!blockedByLoss.decision.isApproved, 'Risk Gate blocks live order when 24h daily loss ($500) exceeds personal cap ($400)');

  // -------------------------------------------------------------------------
  // SCENARIO 4: Outbound Webhook Alerts & SSRF Guard
  // -------------------------------------------------------------------------
  console.log('\n--- [SCENARIO 4: Outbound Webhook Event Dispatch & SSRF Guard] ---');
  let webhookDeliveredEvent = '';
  const whOk = await notifyUserWebhookBestEffort({
    resolveWebhookUrl: async () => 'https://discord.com/api/webhooks/123456/sim-token',
    payload: { event: 'ORDER_APPROVED', title: 'Order Approved', message: 'BUY BTCUSDT approved' },
    fetchImpl: (async (_u: RequestInfo | URL, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body || '{}'));
      webhookDeliveredEvent = String(parsed.content || '');
      return new Response('ok', { status: 204 });
    }) as typeof fetch,
  });
  assert(whOk.delivered && webhookDeliveredEvent.includes('ORDER_APPROVED'), 'Discord webhook receives ORDER_APPROVED alert cleanly');

  const whSsrf = await notifyUserWebhookBestEffort({
    resolveWebhookUrl: async () => 'https://127.0.0.1/admin',
    payload: { event: 'DAILY_LOSS_WARNING', title: 'SSRF Test', message: 'Must block' },
  });
  assert(!whSsrf.delivered && Boolean(whSsrf.error?.includes('SSRF_BLOCKED_HOST')), 'Webhook dispatcher blocks loopback SSRF without throwing');

  // -------------------------------------------------------------------------
  // SCENARIO 5: Soft-Freeze Downgrade & Permanent Add-On Recovery
  // -------------------------------------------------------------------------
  console.log('\n--- [SCENARIO 5: Soft-Freeze Zero-Data-Loss & Add-On Recovery] ---');
  const userKeys = [
    { id: 'k1', isDefault: true, createdAt: '2026-11-19T00:00:00Z' },
    { id: 'k2', isDefault: false, createdAt: '2026-11-20T00:00:00Z' },
    { id: 'k3', isDefault: false, createdAt: '2026-11-21T00:00:00Z' },
  ];
  const frozenOnFree = annotateKeysWithQuotaStatus(userKeys, {
    maxActive: SubscriptionsEngine.getPlanCapacities('FREE').maxLlmKeys,
  });
  assert(frozenOnFree.every((k) => k.quotaStatus === 'FROZEN_OVER_QUOTA'), 'Downgrade to FREE freezes all 3 BYOK LLM keys with zero data loss');

  const withAddon = computeEffectiveVaultCapacity('FREE', { bankrExtraSlots: 5, binanceExtraSlots: 5 });
  assert(withAddon.maxBankrKeys === 6 && withAddon.maxBinanceAccounts === 6, 'Permanent Capacity Add-Ons stack cleanly on top of base tier');

  console.log('\n================================================================');
  console.log(`  🎉 SIMULATION SUITE COMPLETED: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================\n');

  if (failed > 0) process.exit(1);
}

runSimulationSuite().catch((err) => {
  console.error('Simulation suite crashed:', err);
  process.exit(1);
});
