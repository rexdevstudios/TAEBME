import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { computeUnifiedCreatorEarnings } from '../packages/shared/airdrop-referral';

const ROOT = path.resolve(import.meta.dir, '..');

describe('Phase FK: Launchpad Grid/List Screener, Unified Creator Earnings & On-Demand Sub-Wallet Balance', () => {
  test('computeUnifiedCreatorEarnings deterministically sums airdrop referrals and 80% Signal Marketplace revenue', () => {
    const summary = computeUnifiedCreatorEarnings({
      airdropReferralCredits: 45,
      signalMarketplaceCredits: 240,
      signalSalesCount: 3,
    });
    expect(summary.airdropReferralCredits).toBe(45);
    expect(summary.signalMarketplaceCredits).toBe(240);
    expect(summary.signalSalesCount).toBe(3);
    expect(summary.totalCreatorCredits).toBe(285);

    const clamped = computeUnifiedCreatorEarnings({
      airdropReferralCredits: -10,
      signalMarketplaceCredits: NaN,
      signalSalesCount: -2,
    });
    expect(clamped.totalCreatorCredits).toBe(0);
    expect(clamped.signalSalesCount).toBe(0);
  });

  test('wires Grid/List screener toggle in /launchpad, unified creatorEarnings in /kol, and on-demand balances in /agent', () => {
    const launchpadSrc = fs.readFileSync(path.join(ROOT, 'app/launchpad/page.tsx'), 'utf8');
    const refRouteSrc = fs.readFileSync(path.join(ROOT, 'app/api/launchpad/bounty/referrals/route.ts'), 'utf8');
    const kolPageSrc = fs.readFileSync(path.join(ROOT, 'app/kol/page.tsx'), 'utf8');
    const walletsApiSrc = fs.readFileSync(path.join(ROOT, 'app/api/user/owned-wallets/route.ts'), 'utf8');
    const walletsUiSrc = fs.readFileSync(path.join(ROOT, 'app/components/OwnedWalletsAllowlistPanel.tsx'), 'utf8');

    expect(launchpadSrc).toContain("poolViewMode === 'LIST'");
    expect(launchpadSrc).toContain('LayoutGrid');
    expect(refRouteSrc).toContain('MARKETPLACE_CREATOR_REVENUE');
    expect(refRouteSrc).toContain('computeUnifiedCreatorEarnings');
    expect(kolPageSrc).toContain('Signal Sales (80%)');
    expect(kolPageSrc).toContain('Total Creator Earnings');
    expect(walletsApiSrc).toContain("searchParams.get('includeBalances') === '1'");
    expect(walletsApiSrc).toContain('eth_getBalance');
    expect(walletsUiSrc).toContain('Check ETH Balances');
  });
});
