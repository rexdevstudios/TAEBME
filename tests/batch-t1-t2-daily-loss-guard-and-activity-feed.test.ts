import { describe, it, expect } from 'bun:test';
import { NextRequest } from 'next/server';
import { TradingRiskGate, compute24hRiskExposure } from '../packages/trading/risk-gate';
import { GET as getUserActivity } from '../app/api/user/activity/route';

describe('Phase T1–T2: 24h Daily Loss Accumulator & User Security Activity Feed', () => {
  it('[T1.1] compute24hRiskExposure accurately computes realized 24h daily loss and open position count', () => {
    const exp = compute24hRiskExposure({
      fills: [
        { side: 'BUY', quoteValueUsd: 600, status: 'FILLED' },
        { side: 'SELL', quoteValueUsd: 420, status: 'EXECUTED' },
        { side: 'BUY', quoteValueUsd: 100, status: 'CANCELED' }, // ignored
      ],
      openIntentCount: 3,
    });
    expect(exp.currentDailyLossUsd).toBe(180);
    expect(exp.currentOpenPositions).toBe(3);

    // Profitable session -> 0 daily loss
    const profitExp = compute24hRiskExposure({
      fills: [
        { side: 'BUY', quoteValueUsd: 500, status: 'FILLED' },
        { side: 'SELL', quoteValueUsd: 650, status: 'FILLED' },
      ],
      openIntentCount: 0,
    });
    expect(profitExp.currentDailyLossUsd).toBe(0);
    expect(profitExp.currentOpenPositions).toBe(0);
  });

  it('[T1.2] TradingRiskGate deterministically rejects live order when 24h realized loss exceeds maxDailyLossUsd', () => {
    const exposure = compute24hRiskExposure({
      fills: [
        { side: 'BUY', quoteValueUsd: 1200, status: 'FILLED' },
        { side: 'SELL', quoteValueUsd: 900, status: 'FILLED' },
      ],
      openIntentCount: 1,
    });
    expect(exposure.currentDailyLossUsd).toBe(300);

    const { status, decision } = TradingRiskGate.evaluateIntent(
      {
        userId: '0x5555555555555555555555555555555555555555',
        stage: 'LIVE',
        symbol: 'ETHUSDT',
        side: 'BUY',
        type: 'MARKET',
        quantity: 0.05,
        price: 2000,
        maxSlippagePct: 1.0,
        idempotencyKey: 'sim-daily-loss-guard-1',
      },
      {
        maxOrderValueUsd: 1000,
        maxDailyLossUsd: 200, // exposure is $300 -> must reject!
        currentDailyLossUsd: exposure.currentDailyLossUsd,
        maxOpenPositions: 5,
        currentOpenPositions: exposure.currentOpenPositions,
      },
      { planId: 'TRADER', hasLiveTrading: true },
      []
    );

    expect(status).toBe('RISK_REJECTED');
    expect(decision.isApproved).toBe(false);
  });

  it('[T2.1] GET /api/user/activity fails closed (401) without SIWE session', async () => {
    const res = await getUserActivity(new NextRequest('http://localhost/api/user/activity', { method: 'GET' }));
    expect(res.status).toBe(401);
  });
});
