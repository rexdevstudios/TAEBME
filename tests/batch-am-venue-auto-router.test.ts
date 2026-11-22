/**
 * tests/batch-am-venue-auto-router.test.ts
 *
 * Phase AM Unit Tests:
 * - Deterministic CEX Venue Auto-Router (`resolveCexExecutionVenue`)
 * - Keeps AI Agents 100% venue-agnostic while respecting explicit overrides & Soft-Freeze/Mainnet locks.
 */

import { describe, it, expect } from 'bun:test';
import { resolveCexExecutionVenue } from '../packages/trading/venue-router';
import { buildAgentActionCards } from '../packages/agent/skill-registry';

describe('Phase AM — Deterministic Venue-Agnostic CEX Auto-Router', () => {
  const binanceTest = { id: 'bn-t1', isDefault: true, createdAt: '2026-11-22T00:00:00Z', environment: 'TESTNET' as const };
  const binanceMain = { id: 'bn-m1', isDefault: true, createdAt: '2026-11-22T00:00:00Z', environment: 'MAINNET' as const };
  const bybitTest = { id: 'by-t1', isDefault: true, createdAt: '2026-11-22T00:00:00Z', chainScope: 'testnet' };
  const bybitMain = { id: 'by-m1', isDefault: true, createdAt: '2026-11-22T00:00:00Z', chainScope: 'mainnet' };

  it('auto-routes to BINANCE when user has active Binance credentials', () => {
    const res = resolveCexExecutionVenue({
      requestedVenue: 'AUTO',
      planId: 'TRADER',
      binanceAccounts: [binanceMain],
      bybitKeys: [bybitMain],
    });
    expect(res.venue).toBe('BINANCE');
    expect(res.routingMode).toBe('AUTO');
    expect(res.reason).toBe('AUTO_ACTIVE_BINANCE');
    expect(res.activeBinanceCount).toBe(1);
    expect(res.activeBybitCount).toBe(1);
  });

  it('auto-routes to BYBIT when user only has active Bybit V5 credentials', () => {
    const res = resolveCexExecutionVenue({
      requestedVenue: undefined,
      planId: 'FREE',
      binanceAccounts: [],
      bybitKeys: [bybitTest],
    });
    expect(res.venue).toBe('BYBIT');
    expect(res.routingMode).toBe('AUTO');
    expect(res.reason).toBe('AUTO_ACTIVE_BYBIT');
  });

  it('automatically fails over to active Bybit Testnet when Binance Mainnet is locked on FREE tier', () => {
    const res = resolveCexExecutionVenue({
      requestedVenue: 'AUTO',
      planId: 'FREE',
      binanceAccounts: [binanceMain],
      bybitKeys: [bybitTest],
    });
    expect(res.venue).toBe('BYBIT');
    expect(res.reason).toBe('AUTO_ACTIVE_BYBIT');
    expect(res.activeBinanceCount).toBe(0);
    expect(res.activeBybitCount).toBe(1);
    expect(res.allFrozen).toBe(false);
  });

  it('honors explicit venue selection even when both venues are active', () => {
    const res = resolveCexExecutionVenue({
      requestedVenue: 'BYBIT',
      planId: 'AGENT',
      binanceAccounts: [binanceTest],
      bybitKeys: [bybitTest],
    });
    expect(res.venue).toBe('BYBIT');
    expect(res.routingMode).toBe('EXPLICIT');
    expect(res.reason).toBe('EXPLICIT_SELECTION');
  });

  it('fails closed cleanly and flags allFrozen when all configured keys are locked', () => {
    const frozenRes = resolveCexExecutionVenue({
      requestedVenue: 'AUTO',
      planId: 'FREE',
      binanceAccounts: [binanceMain],
      bybitKeys: [bybitMain],
    });
    expect(frozenRes.venue).toBeNull();
    expect(frozenRes.reason).toBe('NO_ACTIVE_CEX_CREDENTIALS');
    expect(frozenRes.allFrozen).toBe(true);

    const emptyRes = resolveCexExecutionVenue({
      requestedVenue: 'AUTO',
      planId: 'FREE',
      binanceAccounts: [],
      bybitKeys: [],
    });
    expect(emptyRes.venue).toBeNull();
    expect(emptyRes.allFrozen).toBe(false);
  });

  it('emits venue-agnostic CEX AUTO action card from AI Skill Registry', () => {
    const cards = buildAgentActionCards({
      skills: ['SKILL_CEX_TRADE'],
      symbol: 'SOLUSDT',
      action: 'BUY',
      quantity: 2,
    });
    expect(cards[0]?.badge).toBe('CEX AUTO');
    expect(cards[0]?.href).toContain('mode=CEX_SINGLE_SHOT');
  });
});
