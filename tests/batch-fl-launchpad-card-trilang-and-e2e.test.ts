import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

describe('Phase FL: Launchpad Two-Row Card Header, Token Chart Tri-Language & Phase FK E2E Coverage', () => {
  test('app/launchpad/page.tsx uses two-row Grid card header so token name and badges never get clipped', () => {
    const src = fs.readFileSync(path.join(ROOT, 'app/launchpad/page.tsx'), 'utf8');
    expect(src).toContain('data-card-header="two-row"');
  });

  test('app/components/TokenMarketChartPanel.tsx wires useLocale() for EN | ID | CN parity', () => {
    const src = fs.readFileSync(path.join(ROOT, 'app/components/TokenMarketChartPanel.tsx'), 'utf8');
    expect(src).toContain("import { useLocale } from '../context/LocaleContext'");
    expect(src).toContain('const { tr } = useLocale()');
    expect(src).toContain('Open DexScreener');
    expect(src).toContain('发布 KOL 喊单');
  });

  test('scripts/test-testnet-full-usecase.ts & CI cover Phase FK includeBalances=1 and creatorEarnings (56 assertions)', () => {
    const e2eSrc = fs.readFileSync(path.join(ROOT, 'scripts/test-testnet-full-usecase.ts'), 'utf8');
    const ciSrc = fs.readFileSync(path.join(ROOT, '.github/workflows/daily-dual-blackbox.yml'), 'utf8');
    expect(e2eSrc).toContain('/api/user/owned-wallets?includeBalances=1');
    expect(e2eSrc).toContain('creatorEarnings.totalCreatorCredits');
    expect(ciSrc).toContain('Testnet E2E (56)');
  });
});
