/**
 * tests/batch-al-vault-summary-telemetry.test.ts
 *
 * Phase AL Unit Tests:
 * 1. `buildUserVaultSummary` accurately aggregates active, frozenOverQuota, and frozenMainnetLocked
 *    counts across Bankr, Binance, Bybit V5, BYOK LLM, and Webhooks on FREE vs AGENT + Add-Ons.
 * 2. `GET /api/user/vault-summary` fails closed with HTTP 401 without an authenticated SIWE session.
 */

import { describe, it, expect } from 'bun:test';
import { NextRequest } from 'next/server';
import { buildUserVaultSummary } from '../packages/billing/subscriptions-engine';
import { GET as getVaultSummary } from '../app/api/user/vault-summary/route';

describe('Phase AL — Unified Multi-Vault Summary Telemetry & Auth Guard', () => {
  const sampleBankr = [
    { id: 'bk1', isDefault: true, createdAt: '2026-11-20T00:00:00Z' },
    { id: 'bk2', isDefault: false, createdAt: '2026-11-21T00:00:00Z' },
  ];
  const sampleBinance = [
    { id: 'bn-main', isDefault: true, createdAt: '2026-11-22T00:00:00Z', environment: 'MAINNET' as const },
    { id: 'bn-test', isDefault: false, createdAt: '2026-11-21T00:00:00Z', environment: 'TESTNET' as const },
  ];
  const sampleBybit = [
    { id: 'by-main', isDefault: true, createdAt: '2026-11-22T00:00:00Z', chainScope: 'mainnet' },
    { id: 'by-test', isDefault: false, createdAt: '2026-11-21T00:00:00Z', chainScope: 'testnet' },
  ];
  const sampleLlm = [
    { id: 'llm1', isDefault: true, createdAt: '2026-11-20T00:00:00Z' },
    { id: 'llm2', isDefault: false, createdAt: '2026-11-21T00:00:00Z' },
  ];
  const sampleWebhooks = [
    { id: 'wh1', isDefault: true, createdAt: '2026-11-20T00:00:00Z' },
  ];

  it('computes strict Soft-Freeze & Mainnet Lock telemetry on FREE tier with decoupled webhook quota', () => {
    const summary = buildUserVaultSummary({
      planId: 'FREE',
      addonSlots: { bankrExtraSlots: 0, binanceExtraSlots: 0 },
      bankrKeys: sampleBankr,
      binanceAccounts: sampleBinance,
      bybitKeys: sampleBybit,
      llmKeys: sampleLlm,
      webhookKeys: sampleWebhooks,
    });

    expect(summary.planId).toBe('FREE');
    expect(summary.allowMainnetCex).toBe(false);

    // Bankr: FREE max 1 -> 1 active, 1 frozenOverQuota
    expect(summary.vaults.bankr).toEqual({
      total: 2,
      active: 1,
      frozenOverQuota: 1,
      frozenMainnetLocked: 0,
      maxAllowed: 1,
    });

    // Binance & Bybit: FREE max 1, allowMainnet=false -> Mainnet locked, Testnet active
    expect(summary.vaults.binance).toEqual({
      total: 2,
      active: 1,
      frozenOverQuota: 0,
      frozenMainnetLocked: 1,
      maxAllowed: 1,
    });
    expect(summary.vaults.bybit).toEqual({
      total: 2,
      active: 1,
      frozenOverQuota: 0,
      frozenMainnetLocked: 1,
      maxAllowed: 1,
    });

    // BYOK LLM: FREE max 0 -> 0 active, 2 frozenOverQuota
    expect(summary.vaults.byokLlm).toEqual({
      total: 2,
      active: 0,
      frozenOverQuota: 2,
      frozenMainnetLocked: 0,
      maxAllowed: 0,
    });

    // Webhook: decoupled quota 2 -> 1 active
    expect(summary.vaults.webhook).toEqual({
      total: 1,
      active: 1,
      frozenOverQuota: 0,
      frozenMainnetLocked: 0,
      maxAllowed: 2,
    });
  });

  it('unlocks all vaults and stacks permanent add-on slots cleanly on AGENT tier', () => {
    const summary = buildUserVaultSummary({
      planId: 'AGENT',
      addonSlots: { bankrExtraSlots: 5, binanceExtraSlots: 3 },
      bankrKeys: sampleBankr,
      binanceAccounts: sampleBinance,
      bybitKeys: sampleBybit,
      llmKeys: sampleLlm,
      webhookKeys: sampleWebhooks,
    });

    expect(summary.planId).toBe('AGENT');
    expect(summary.allowMainnetCex).toBe(true);
    expect(summary.vaults.bankr.maxAllowed).toBe(30);
    expect(summary.vaults.bankr.active).toBe(2);
    expect(summary.vaults.binance.maxAllowed).toBe(18);
    expect(summary.vaults.binance.active).toBe(2);
    expect(summary.vaults.binance.frozenMainnetLocked).toBe(0);
    expect(summary.vaults.bybit.maxAllowed).toBe(18);
    expect(summary.vaults.bybit.active).toBe(2);
    expect(summary.vaults.bybit.frozenMainnetLocked).toBe(0);
    expect(summary.vaults.byokLlm.maxAllowed).toBe(5);
    expect(summary.vaults.byokLlm.active).toBe(2);
  });

  it('GET /api/user/vault-summary fails closed with HTTP 401 when unauthenticated', async () => {
    const req = new NextRequest('http://localhost:3000/api/user/vault-summary', { method: 'GET' });
    const res = await getVaultSummary(req);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.success).toBe(false);
  });
});
