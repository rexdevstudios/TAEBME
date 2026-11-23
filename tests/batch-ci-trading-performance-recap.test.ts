import { describe, expect, it } from 'bun:test';
import {
  computeTradingPerformanceRecap,
  encodeDexSettlementIdempotencyKey,
} from '../packages/launchpad/web3-provider';

describe('Phase CI: Live Portfolio & Auto-Pilot Performance Recap Calculator', () => {
  it('CI1.1 returns clean zeroed metrics on empty trade intent history', () => {
    const recap = computeTradingPerformanceRecap([]);
    expect(recap).toEqual({
      totalTrades: 0,
      executedOrApproved: 0,
      blockedOrRejected: 0,
      executionRatePct: 0,
      estimatedVolumeUsd: 0,
      dexCount: 0,
      autoPilotCount: 0,
      trailingStopCount: 0,
      topSymbol: null,
    });
  });

  it('CI1.2 aggregates execution rate, USD volume, DEX settled, Auto-Pilot, Trailing Stop, Risk Blocks & topSymbol accurately', () => {
    const dexKey = encodeDexSettlementIdempotencyKey({
      chainId: 42161,
      txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      intentId: 'intent-ci-1',
    });
    const recap = computeTradingPerformanceRecap([
      {
        symbol: 'BTCUSDT',
        quantity: 0.05,
        price: 90000,
        status: 'EXECUTED',
        idempotencyKey: 'autopilot:0xabc:BTCUSDT:BUY:100',
      },
      {
        symbol: 'BTCUSDT',
        quantity: 0.05,
        price: 94000,
        status: 'EXECUTED',
        idempotencyKey: 'autopilot:0xabc:BTCUSDT:TRAILING_STOP_SELL:101',
      },
      {
        symbol: 'USDC',
        quantity: 250,
        price: 1,
        status: 'EXECUTED',
        idempotencyKey: dexKey,
      },
      {
        symbol: 'SCAM',
        quantity: 1000,
        price: 0.5,
        status: 'BLOCKED',
        idempotencyKey: 'manual-honeypot-block',
      },
    ]);

    expect(recap.totalTrades).toBe(4);
    expect(recap.executedOrApproved).toBe(3);
    expect(recap.blockedOrRejected).toBe(1);
    expect(recap.executionRatePct).toBe(75);
    // 0.05*90000 (4500) + 0.05*94000 (4700) + 250*1 (250) = 9450; BLOCKED excluded from volume
    expect(recap.estimatedVolumeUsd).toBe(9450);
    expect(recap.dexCount).toBe(1);
    expect(recap.autoPilotCount).toBe(2);
    expect(recap.trailingStopCount).toBe(1);
    expect(recap.topSymbol).toBe('BTCUSDT');
  });

  it('CI1.3 safely ignores missing/zero/NaN price or quantity without producing NaN volume', () => {
    const recap = computeTradingPerformanceRecap([
      { symbol: 'ETHUSDT', quantity: 1, price: undefined, status: 'APPROVED' },
      { symbol: 'ETHUSDT', quantity: Number.NaN, price: 3000, status: 'EXECUTED' },
      { symbol: 'ETHUSDT', quantity: -2, price: 3000, status: 'EXECUTED' },
    ]);

    expect(recap.totalTrades).toBe(3);
    expect(recap.executedOrApproved).toBe(3);
    expect(recap.executionRatePct).toBe(100);
    expect(recap.estimatedVolumeUsd).toBe(0);
    expect(recap.topSymbol).toBe('ETHUSDT');
  });
});
