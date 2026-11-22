import { describe, expect, it } from 'bun:test';
import {
  buildAutonomousTerminalSnapshot,
  formatScoutCacheAgeLabel,
} from '../packages/agent/autonomous-terminal-engine';

describe('Phase AV: Scout Cache Freshness Telemetry & Dual-Control Contract', () => {
  it('[AV1.1] formatScoutCacheAgeLabel renders deterministic relative age strings and safe fallbacks', () => {
    const now = Date.parse('2026-11-23T01:00:00.000Z');
    expect(formatScoutCacheAgeLabel(null, now)).toBe('Awaiting Cron Sync');
    expect(formatScoutCacheAgeLabel(undefined, now)).toBe('Awaiting Cron Sync');
    expect(formatScoutCacheAgeLabel('not-a-date', now)).toBe('Awaiting Cron Sync');
    expect(formatScoutCacheAgeLabel('2026-11-23T00:59:35.000Z', now)).toBe('Synced <1m ago');
    expect(formatScoutCacheAgeLabel('2026-11-23T00:48:00.000Z', now)).toBe('Synced 12m ago');
    expect(formatScoutCacheAgeLabel('2026-11-22T22:00:00.000Z', now)).toBe('Synced 3h ago');
    expect(formatScoutCacheAgeLabel('2026-11-21T01:00:00.000Z', now)).toBe('Synced 2d ago');
  });

  it('[AV1.2] buildAutonomousTerminalSnapshot propagates scoutDatasetSyncedAt & scoutDatasetHintCount without breaking defaults', () => {
    const syncedIso = '2026-11-23T00:50:00.000Z';
    const withCache = buildAutonomousTerminalSnapshot({
      planId: 'AGENT',
      intents: [],
      activeLaunches: [],
      hasActiveCexKey: true,
      hasZeroXApiKey: true,
      hasFirecrawlApiKey: true,
      scoutDatasetSyncedAt: syncedIso,
      firecrawlHints: [
        { symbol: 'AERO', note: 'Scout boosted on Base → 0x Swap v2 ready', tokenAddress: '0x940181a94A35A4569E4529A3CDfB74e38FD98631' },
        { symbol: 'DEGEN', note: 'Scout trending Base token → 0x Swap v2 ready', tokenAddress: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed' },
      ],
    });
    expect(withCache.dualRailReadiness.scoutDatasetSyncedAt).toBe(syncedIso);
    expect(withCache.dualRailReadiness.scoutDatasetHintCount).toBe(2);

    const withoutCache = buildAutonomousTerminalSnapshot({
      planId: 'FREE',
      intents: [],
      activeLaunches: [],
      hasActiveCexKey: false,
      hasZeroXApiKey: false,
      hasFirecrawlApiKey: false,
    });
    expect(withoutCache.dualRailReadiness.scoutDatasetSyncedAt).toBeNull();
    expect(withoutCache.dualRailReadiness.scoutDatasetHintCount).toBe(0);
  });
});
