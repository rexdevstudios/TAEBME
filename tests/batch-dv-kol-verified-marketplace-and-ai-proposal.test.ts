/**
 * Unit Suite #89 — Phase DV:
 * Verified KOL Consensus in AI Proposal Engine & KOL VERIFIED Badges on Signal Marketplace.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  enrichMarketplacePresetsWithKolStatus,
  type KolProfileSample,
} from '../packages/intelligence/kol-chart-overlay';

describe('Phase DV — Verified KOL Marketplace Badges & AI Proposal Consensus', () => {
  test('enrichMarketplacePresetsWithKolStatus annotates GOLD/SILVER verified KOLs vs UNVERIFIED creators', () => {
    const kolMap = new Map<string, KolProfileSample>([
      [
        '0x1111111111111111111111111111111111111111',
        {
          walletAddress: '0x1111111111111111111111111111111111111111',
          twitterHandle: 'alpha_whale',
          trustScore: 92,
        },
      ],
      [
        '0x2222222222222222222222222222222222222222',
        {
          walletAddress: '0x2222222222222222222222222222222222222222',
          twitterHandle: 'low_trust',
          trustScore: 40,
        },
      ],
    ]);

    const enriched = enrichMarketplacePresetsWithKolStatus(
      [
        { id: 'p1', creatorWallet: '0x1111111111111111111111111111111111111111' },
        { id: 'p2', creatorWallet: '0x2222222222222222222222222222222222222222' },
        { id: 'p3', creatorWallet: '0x3333333333333333333333333333333333333333' },
      ],
      kolMap
    );

    expect(enriched[0].kolVerified).toBe(true);
    expect(enriched[0].kolTier).toBe('GOLD');
    expect(enriched[0].kolHandle).toBe('@alpha_whale');

    expect(enriched[1].kolVerified).toBe(false);
    expect(enriched[1].kolTier).toBe('UNVERIFIED');

    expect(enriched[2].kolVerified).toBe(false);
    expect(enriched[2].kolTier).toBe('UNVERIFIED');
  });

  test('AI Proposal Engine, Market Chart, and Signal Marketplace reuse shared KOL overlay helpers', () => {
    const root = join(import.meta.dir, '..');
    const propRoute = readFileSync(join(root, 'app/api/agent/proposals/intelligence/route.ts'), 'utf8');
    expect(propRoute).toContain('loadVerifiedKolSignalsForSymbol');
    expect(propRoute).toContain('computeAntiManipulationKolConsensus');
    expect(propRoute).toContain('kolConsensus');

    const chartRoute = readFileSync(join(root, 'app/api/market/chart/route.ts'), 'utf8');
    expect(chartRoute).toContain('loadVerifiedKolSignalsForSymbol');

    const mktRoute = readFileSync(join(root, 'app/api/agent/marketplace/route.ts'), 'utf8');
    expect(mktRoute).toContain('enrichMarketplacePresetsWithKolStatus');

    const mktPanel = readFileSync(join(root, 'app/components/SignalMarketplacePanel.tsx'), 'utf8');
    expect(mktPanel).toContain('KOL VERIFIED');
  });
});
