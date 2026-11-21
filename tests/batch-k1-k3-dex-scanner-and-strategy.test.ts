import { describe, it, expect } from 'bun:test';
import {
  STRATEGY_PROFILES,
  evaluateDexStrategyFit,
  type DexTokenSnapshot,
} from '../packages/intelligence/dex-market-scanner';
import { runFiveAgentDeskCycle } from '../packages/agent/trading-desk-orchestrator';

describe('Phase K1–K3 — Modular DEX Market Scanner & Strategy Profiles', () => {
  const sampleHealthySnapshot: DexTokenSnapshot = {
    tokenAddress: '0x4200000000000000000000000000000000000006',
    symbol: 'NOIR',
    name: 'NoirPay',
    chainId: 'base',
    dexId: 'uniswap',
    priceUsd: 0.0142,
    liquidityUsd: 85000,
    volume24hUsd: 240000,
    fdvUsd: 1420000,
    priceChange1h: 8.5,
    priceChange24h: 22.4,
    buys24h: 140,
    sells24h: 80,
    buyRatioPct: 64,
    pairUrl: 'https://dexscreener.com/base/0x4200000000000000000000000000000000000006',
    geckoTerminalUrl: 'https://www.geckoterminal.com/base/tokens/0x4200000000000000000000000000000000000006',
    source: 'DEXSCREENER',
    fetchedAt: new Date().toISOString(),
  };

  it('K1.1 — exposes all 4 modular strategy profiles with positive thresholds', () => {
    expect(Object.keys(STRATEGY_PROFILES)).toEqual([
      'EARLY_SNIPER',
      'MOMENTUM_BREAKOUT',
      'DIP_ACCUMULATOR',
      'CONSERVATIVE_DCA',
    ]);
    expect(STRATEGY_PROFILES.CONSERVATIVE_DCA.minLiquidityUsd).toBeGreaterThan(
      STRATEGY_PROFILES.EARLY_SNIPER.minLiquidityUsd
    );
  });

  it('K1.2 — evaluateDexStrategyFit rewards healthy liquidity + buy pressure and flags low liquidity / sell pressure / extreme pump', () => {
    const healthyFit = evaluateDexStrategyFit(sampleHealthySnapshot, 'MOMENTUM_BREAKOUT');
    expect(healthyFit.scoreDelta).toBeGreaterThan(0);
    expect(healthyFit.riskFlags).toEqual([]);

    const riskySnapshot: DexTokenSnapshot = {
      ...sampleHealthySnapshot,
      liquidityUsd: 1200,
      buys24h: 5,
      sells24h: 35,
      buyRatioPct: 13,
      priceChange1h: 210,
    };
    const riskyFit = evaluateDexStrategyFit(riskySnapshot, 'MOMENTUM_BREAKOUT');
    expect(riskyFit.scoreDelta).toBeLessThan(0);
    expect(riskyFit.riskFlags).toContain('LOW_DEX_LIQUIDITY');
    expect(riskyFit.riskFlags).toContain('SELL_PRESSURE_DOMINANT');
    expect(riskyFit.riskFlags).toContain('EXTREME_PUMP_1H');
  });

  it('K1.3 — runFiveAgentDeskCycle integrates live DEX snapshot & strategyProfile while keeping Risk Gate immutable', async () => {
    const report = await runFiveAgentDeskCycle(
      {
        userId: 'usr-k1-test',
        symbol: 'TOKEN',
        action: 'BUY',
        quantity: 50,
        maxSlippagePct: 1.5,
        mode: 'PAPER',
        tokenAddress: sampleHealthySnapshot.tokenAddress,
        dexNetwork: 'base',
        strategyProfile: 'MOMENTUM_BREAKOUT',
      },
      {
        proposalDb: {
          createProposal: async () => 'prop-k1-001',
          createAuditLog: async () => {},
        } as any,
        getActiveLaunchesCount: async () => 11,
        getActiveKillSwitches: async () => [],
        getUserEntitlement: async () => ({ planId: 'AGENT', hasLiveTrading: true }),
        saveTradeIntent: async () => 'intent-k1-001',
        fetchMacroSignal: async () => null,
        fetchDexSnapshot: async () => sampleHealthySnapshot,
      }
    );

    expect(report.symbol).toBe('NOIR');
    expect(report.strategyProfile).toBe('MOMENTUM_BREAKOUT');
    expect(report.dexSnapshot?.liquidityUsd).toBe(85000);
    expect(report.rulesImmutable).toBe(true);
    expect(report.collisions).toBe(0);
    expect(report.execution.status).toBe('FILLED_SIMULATED');
    expect(report.execution.handoffUrl).toContain(sampleHealthySnapshot.tokenAddress);
  });
});
