import { describe, expect, it } from 'bun:test';
import {
  DEXSCREENER_EVM_CHAIN_MAP,
  buildAutonomousTerminalSnapshot,
  mapDexScreenerBoostRowsToScoutHints,
} from '../packages/agent/autonomous-terminal-engine';

describe('Phase AY: Multi-Chain 6-EVM Scout Discovery Mapper & Handoff Wiring', () => {
  it('[AY1.1] DEXSCREENER_EVM_CHAIN_MAP covers all 6 supported 0x Swap v2 EVM networks', () => {
    expect(Object.keys(DEXSCREENER_EVM_CHAIN_MAP).sort()).toEqual([
      'arbitrum',
      'base',
      'bsc',
      'ethereum',
      'optimism',
      'polygon',
    ]);
    expect(DEXSCREENER_EVM_CHAIN_MAP.base.chainId).toBe(8453);
    expect(DEXSCREENER_EVM_CHAIN_MAP.arbitrum.chainId).toBe(42161);
    expect(DEXSCREENER_EVM_CHAIN_MAP.bsc.chainId).toBe(56);
  });

  it('[AY1.2] mapDexScreenerBoostRowsToScoutHints maps valid 6-chain EVM rows and filters out non-EVM or malformed addresses', () => {
    const nowIso = '2026-11-23T04:00:00.000Z';
    const rawRows = [
      {
        chainId: 'solana',
        tokenAddress: 'So11111111111111111111111111111111111111112',
        symbol: 'SOL',
      },
      {
        chainId: 'arbitrum',
        tokenAddress: '0x912CE59144191C1204E64559FE8253a0e49E6548',
        symbol: 'arb',
        description: 'Arbitrum governance momentum',
      },
      {
        chainId: 'bsc',
        tokenAddress: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
        description: '',
      },
      {
        chainId: 'base',
        tokenAddress: 'not-an-evm-address',
      },
    ];

    const hints = mapDexScreenerBoostRowsToScoutHints(rawRows, nowIso, 6);
    expect(hints.length).toBe(2);

    expect(hints[0].symbol).toBe('ARB');
    expect(hints[0].chainId).toBe(42161);
    expect(hints[0].note).toContain('Scout boosted on Arbitrum:');

    expect(hints[1].symbol).toBe('BSC_0E09');
    expect(hints[1].chainId).toBe(56);
    expect(hints[1].note).toContain('Scout trending BNB Chain token');
  });

  it('[AY2.1] buildAutonomousTerminalSnapshot propagates hint.chainId into Scout liveFeed handoff URLs', () => {
    const snap = buildAutonomousTerminalSnapshot({
      planId: 'TRADER',
      intents: [],
      activeLaunches: [],
      hasActiveCexKey: true,
      hasZeroXApiKey: true,
      hasFirecrawlApiKey: true,
      firecrawlHints: [
        {
          symbol: 'ARB',
          tokenAddress: '0x912CE59144191C1204E64559FE8253a0e49E6548',
          chainId: 42161,
          note: 'Scout boosted on Arbitrum → 0x Swap v2 ready',
        },
        {
          symbol: 'CAKE',
          tokenAddress: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
          chainId: 56,
          note: 'Scout boosted on BNB Chain → 0x Swap v2 ready',
        },
      ],
    });

    const arbFeed = snap.liveFeed.find((f) => f.id === 'scout-ARB-42161');
    const bscFeed = snap.liveFeed.find((f) => f.id === 'scout-CAKE-56');
    expect(arbFeed?.href).toContain('chainId=42161');
    expect(bscFeed?.href).toContain('chainId=56');
  });
});
