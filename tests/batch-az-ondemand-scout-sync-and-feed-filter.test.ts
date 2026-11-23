import { describe, expect, it } from 'bun:test';
import {
  buildAutonomousTerminalSnapshot,
  filterTerminalLiveFeed,
  shouldTriggerOnDemandScoutSync,
} from '../packages/agent/autonomous-terminal-engine';

describe('Phase AZ: On-Demand Scout Sync Cooldown Guard & Multi-Chain/Rail Feed Filter', () => {
  it('[AZ1.1] shouldTriggerOnDemandScoutSync enforces 60s cooldown and allows empty/expired cache when refreshRequested=true', () => {
    const nowMs = Date.parse('2026-11-23T05:00:00.000Z');

    // Not requested -> always false
    expect(
      shouldTriggerOnDemandScoutSync({
        refreshRequested: false,
        lastSyncedAtIso: null,
        nowMs,
      })
    ).toBe(false);

    // Requested + empty cache -> true
    expect(
      shouldTriggerOnDemandScoutSync({
        refreshRequested: true,
        lastSyncedAtIso: null,
        nowMs,
      })
    ).toBe(true);

    // Requested + synced 30s ago (< 60s cooldown) -> false
    expect(
      shouldTriggerOnDemandScoutSync({
        refreshRequested: true,
        lastSyncedAtIso: '2026-11-23T04:59:30.000Z',
        nowMs,
        cooldownSec: 60,
      })
    ).toBe(false);

    // Requested + synced 65s ago (>= 60s cooldown) -> true
    expect(
      shouldTriggerOnDemandScoutSync({
        refreshRequested: true,
        lastSyncedAtIso: '2026-11-23T04:58:55.000Z',
        nowMs,
        cooldownSec: 60,
      })
    ).toBe(true);
  });

  it('[AZ1.2] filterTerminalLiveFeed filters accurately by ALL, ExecutionRailId, and numeric EVM chainId', () => {
    const snap = buildAutonomousTerminalSnapshot({
      planId: 'AGENT',
      intents: [],
      activeLaunches: [{ ticker: 'LAVA', bondingProgressPct: 50 }],
      hasActiveCexKey: true,
      hasZeroXApiKey: true,
      hasFirecrawlApiKey: true,
      firecrawlHints: [
        {
          symbol: 'AERO',
          chainId: 8453,
          tokenAddress: '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
          note: 'Scout Base',
        },
        {
          symbol: 'ARB',
          chainId: 42161,
          tokenAddress: '0x912CE59144191C1204E64559FE8253a0e49E6548',
          note: 'Scout Arbitrum',
        },
        {
          symbol: 'CAKE',
          chainId: 56,
          tokenAddress: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
          note: 'Scout BSC',
        },
      ],
    });

    expect(filterTerminalLiveFeed(snap.liveFeed, 'ALL').length).toBe(5);
    expect(filterTerminalLiveFeed(snap.liveFeed, 'INTERNAL_LAUNCHPAD').length).toBe(1);
    expect(filterTerminalLiveFeed(snap.liveFeed, 'EXTERNAL_DEX_0X').length).toBe(3);
    expect(filterTerminalLiveFeed(snap.liveFeed, 'EXTERNAL_CEX_AUTO').length).toBe(1);

    // Chain ID filter: Base (8453) includes both INTERNAL_LAUNCHPAD (Base) and Base Scout
    expect(filterTerminalLiveFeed(snap.liveFeed, 8453).length).toBe(2);
    expect(filterTerminalLiveFeed(snap.liveFeed, 42161).length).toBe(1);
    expect(filterTerminalLiveFeed(snap.liveFeed, 56).length).toBe(1);
  });
});
