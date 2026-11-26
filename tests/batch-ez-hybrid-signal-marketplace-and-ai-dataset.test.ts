import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildAutoPilotDraftFromPreset,
  buildMarketplaceDatasetAdvisorySummary,
} from '../packages/agent/signal-marketplace';
import { PostgresBillingDbAdapter } from '../packages/db/billing-repo';

const ROOT = path.resolve(import.meta.dir, '..');

describe('Phase EZ: Hybrid Signal Marketplace (AI Dataset + Draft Pre-Fill + Anti-Double-Charge)', () => {
  test('buildAutoPilotDraftFromPreset enforces non-custodial autoEnable=false and clamps risk bounds', () => {
    const draft = buildAutoPilotDraftFromPreset({
      id: 'preset-1',
      title: 'Base Alpha Swing',
      rail: 'DEX_SESSION',
      takeProfitPct: 22,
      stopLossPct: 6,
      trailingStopPct: 3.5,
      allowedSymbols: ['ETHUSDT', 'SOLUSDT'],
    });
    expect(draft.autoEnable).toBe(false);
    expect(draft.rail).toBe('DEX_SESSION');
    expect(draft.takeProfitPct).toBe(22);
    expect(draft.stopLossPct).toBe(6);
    expect(draft.trailingStopPct).toBe(3.5);
    expect(draft.allowedSymbols).toEqual(['ETHUSDT', 'SOLUSDT']);
  });

  test('buildMarketplaceDatasetAdvisorySummary prioritizes KOL Verified presets and summarizes TP/SL/Trail', () => {
    expect(buildMarketplaceDatasetAdvisorySummary([])).toBeNull();

    const summary = buildMarketplaceDatasetAdvisorySummary(
      [
        {
          id: 'p1',
          title: 'Community Grid',
          description: 'grid',
          creatorWallet: '0x1111111111111111111111111111111111111111',
          priceCredits: 50,
          rail: 'CEX_AUTO',
          takeProfitPct: 10,
          stopLossPct: 4,
          trailingStopPct: 2,
          allowedSymbols: ['BTCUSDT'],
          subscribersCount: 20,
          createdAt: '2026-11-26T00:00:00Z',
          kolVerified: false,
        },
        {
          id: 'p2',
          title: 'Verified KOL Trend',
          description: 'trend',
          creatorWallet: '0x2222222222222222222222222222222222222222',
          priceCredits: 100,
          rail: 'CEX_AUTO',
          takeProfitPct: 20,
          stopLossPct: 6,
          trailingStopPct: 4,
          allowedSymbols: ['BTCUSDT', 'ETHUSDT'],
          subscribersCount: 5,
          createdAt: '2026-11-26T00:00:00Z',
          kolVerified: true,
        },
      ],
      'BTCUSDT'
    );

    expect(summary).not.toBeNull();
    expect(summary?.totalPresets).toBe(2);
    expect(summary?.verifiedPresetsCount).toBe(1);
    expect(summary?.avgTakeProfitPct).toBe(15);
    expect(summary?.avgStopLossPct).toBe(5);
    expect(summary?.avgTrailingStopPct).toBe(3);
    expect(summary?.topPresetTitle).toBe('Verified KOL Trend');
  });

  test('subscribeMarketplacePreset is idempotent (anti-double-charge on repeat subscribe)', async () => {
    const repo = new PostgresBillingDbAdapter({
      getDbPool: () => null,
      ensureUserEntity: async (_p, u) => u,
    });
    const creator = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const subscriber = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    await repo.updateUserSubscription(creator, 'FREE');
    await repo.updateUserSubscription(subscriber, 'CREATOR');

    const preset = await repo.publishMarketplacePreset({
      title: 'Idempotent Momentum',
      description: 'Safe momentum preset',
      creatorWallet: creator,
      priceCredits: 100,
      rail: 'CEX_AUTO',
      takeProfitPct: 15,
      stopLossPct: 5,
      trailingStopPct: 3,
      allowedSymbols: ['BTCUSDT'],
    });

    const sub1 = await repo.subscribeMarketplacePreset(subscriber, preset.id);
    expect(sub1.ok).toBe(true);
    expect(sub1.alreadySubscribed).toBeUndefined();
    expect(sub1.split?.totalCredits).toBe(100);
    const balAfterFirst = await repo.getUserCreditBalance(subscriber);

    const sub2 = await repo.subscribeMarketplacePreset(subscriber, preset.id);
    expect(sub2.ok).toBe(true);
    expect(sub2.alreadySubscribed).toBe(true);
    expect(sub2.split?.totalCredits).toBe(0);
    expect(await repo.getUserCreditBalance(subscriber)).toBe(balAfterFirst);
  });

  test('wires AI Copilot dataset grounding, non-custodial draft pre-fill, and /leaderboard direct Apply CTA', () => {
    const copilotSrc = fs.readFileSync(path.join(ROOT, 'app/api/agent/copilot/chat/route.ts'), 'utf8');
    const apSrc = fs.readFileSync(path.join(ROOT, 'app/components/AutoPilotControlPanel.tsx'), 'utf8');
    const mktSrc = fs.readFileSync(path.join(ROOT, 'app/components/SignalMarketplacePanel.tsx'), 'utf8');
    const agentSrc = fs.readFileSync(path.join(ROOT, 'app/agent/page.tsx'), 'utf8');
    const lbSrc = fs.readFileSync(path.join(ROOT, 'app/leaderboard/page.tsx'), 'utf8');

    expect(copilotSrc).toContain('buildMarketplaceDatasetAdvisorySummary');
    expect(copilotSrc).toContain('marketplaceDataset');
    expect(apSrc).toContain('draftTemplate');
    expect(apSrc).not.toContain('setEnabled(true)');
    expect(mktSrc).toContain('buildAutoPilotDraftFromPreset');
    expect(mktSrc).toContain('publishRail');
    expect(mktSrc).toContain('symbolsInput');
    expect(agentSrc).toContain('draftAutoPilotTemplate');
    expect(agentSrc).toContain('highlightedPresetId');
    expect(lbSrc).toContain('KOL VERIFIED');
    expect(lbSrc).toContain('/agent?tab=autopilot&presetId=');
  });
});
