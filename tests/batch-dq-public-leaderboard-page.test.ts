/**
 * Unit Suite #84 — Phase DQ:
 * Public Unified /leaderboard Competition Page & Sidebar Navigation Parity.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { I18N_DICTIONARY } from '../packages/shared/i18n-dictionary';

describe('Phase DQ — Public Unified /leaderboard Competition Page', () => {
  test('i18n dictionary provides symmetrical EN & ID nav.leaderboard keys', () => {
    expect(I18N_DICTIONARY.en['nav.leaderboard']).toBe('Leaderboard');
    expect(I18N_DICTIONARY.id['nav.leaderboard']).toBe('Peringkat');
  });

  test('HeaderNav links /leaderboard and app/leaderboard/page.tsx aggregates all 3 public endpoints', () => {
    const root = join(import.meta.dir, '..');
    const navSrc = readFileSync(join(root, 'app/components/HeaderNav.tsx'), 'utf8');
    expect(navSrc).toContain("href: '/leaderboard'");
    expect(navSrc).toContain("t('nav.leaderboard')");

    const lbSrc = readFileSync(join(root, 'app/leaderboard/page.tsx'), 'utf8');
    expect(lbSrc).toContain('/api/gamefi/genesis-sbt');
    expect(lbSrc).toContain('/api/prop/challenge');
    expect(lbSrc).toContain('/api/agent/marketplace');
    expect(lbSrc).toContain('POOLNET Global Leaderboard');
  });
});
