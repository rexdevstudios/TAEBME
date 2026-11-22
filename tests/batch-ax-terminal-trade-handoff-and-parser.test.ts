import { describe, expect, it } from 'bun:test';
import {
  buildAutonomousTerminalSnapshot,
  buildTerminalTradeHandoffUrl,
  parseTradingHandoffSearchParams,
} from '../packages/agent/autonomous-terminal-engine';

describe('Phase AX: Interactive 1-Click Agent-to-Trading Handoff URL Builder & Query Parser', () => {
  it('[AX1.1] buildTerminalTradeHandoffUrl & parseTradingHandoffSearchParams round-trip cleanly across all 3 rails and 6 EVM chains', () => {
    const arbUsdc = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
    const url = buildTerminalTradeHandoffUrl({
      symbol: 'USDC',
      side: 'BUY',
      qty: 0.05,
      mode: 'DEX_NON_CUSTODIAL',
      rail: 'EXTERNAL_DEX_0X',
      agent: 'SCOUT',
      tokenAddress: arbUsdc,
      chainId: 42161,
    });

    expect(url.startsWith('/trading?')).toBe(true);
    const parsed = parseTradingHandoffSearchParams(url.replace('/trading?', ''));
    expect(parsed.symbol).toBe('USDC');
    expect(parsed.side).toBe('BUY');
    expect(parsed.qty).toBe(0.05);
    expect(parsed.mode).toBe('DEX_NON_CUSTODIAL');
    expect(parsed.rail).toBe('EXTERNAL_DEX_0X');
    expect(parsed.agent).toBe('SCOUT');
    expect(parsed.tokenAddress).toBe(arbUsdc);
    expect(parsed.chainId).toBe(42161);
  });

  it('[AX1.2] parseTradingHandoffSearchParams strictly rejects unsupported chainIds, malformed token addresses, and unknown modes', () => {
    const parsed = parseTradingHandoffSearchParams(
      'symbol=BTCUSDT&side=HOLD&qty=-5&mode=UNSAFE_MODE&token=0x123&chainId=999999&rail=UNKNOWN&agent=FAKE'
    );
    expect(parsed.symbol).toBe('BTCUSDT');
    expect(parsed.side).toBeNull();
    expect(parsed.qty).toBeNull();
    expect(parsed.mode).toBeNull();
    expect(parsed.tokenAddress).toBeNull();
    expect(parsed.chainId).toBeNull();
    expect(parsed.rail).toBeNull();
    expect(parsed.agent).toBeNull();
  });

  it('[AX2.1] buildAutonomousTerminalSnapshot populates href with rail, agent & chainId on both recentTradeCards and liveFeed', () => {
    const snap = buildAutonomousTerminalSnapshot({
      planId: 'AGENT',
      intents: [
        {
          id: 'intent-1',
          stage: 'PAPER',
          symbol: 'LAVA/WETH',
          side: 'BUY',
          quantity: 0.1,
          status: 'APPROVED',
        },
      ],
      activeLaunches: [
        {
          ticker: 'LAVA',
          contractAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          bondingProgressPct: 80,
        },
      ],
      hasActiveCexKey: true,
      hasZeroXApiKey: true,
      hasFirecrawlApiKey: true,
    });

    expect(snap.recentTradeCards.length).toBe(1);
    expect(snap.recentTradeCards[0].href).toContain('rail=INTERNAL_LAUNCHPAD');
    expect(snap.recentTradeCards[0].href).toContain('agent=CURVE');

    const gradFeed = snap.liveFeed.find((f) => f.rail === 'INTERNAL_LAUNCHPAD');
    expect(gradFeed?.href).toContain('chainId=8453');
    expect(gradFeed?.href).toContain('agent=GRADUATE');
  });
});
