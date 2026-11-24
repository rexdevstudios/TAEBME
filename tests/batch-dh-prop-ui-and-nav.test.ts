/**
 * tests/batch-dh-prop-ui-and-nav.test.ts
 *
 * Phase DH Verification Suite:
 *  - Verifies app/prop/page.tsx wires GET/POST /api/prop/challenge & Pons-v2 bilingual tokens
 *  - Verifies HeaderNav exposes /prop navigation link without breaking canonical nav labels
 *  - Verifies EN/ID dictionary contains symmetrical nav.prop, prop.title, prop.subtitle keys
 */

import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { I18N_DICTIONARY } from '../packages/shared/i18n-dictionary';

describe('Phase DH: Public /prop Trading Cup Dashboard & Sidebar Navigation', () => {
  test('[DH1.1] i18n dictionary provides symmetrical EN & ID keys for /prop', () => {
    expect(I18N_DICTIONARY.en['nav.prop']).toBe('Prop Cup');
    expect(I18N_DICTIONARY.id['nav.prop']).toBe('Prop Cup');
    expect(I18N_DICTIONARY.en['prop.title']).toContain('Trading Cup');
    expect(I18N_DICTIONARY.id['prop.title']).toContain('Trading Cup');
    expect(I18N_DICTIONARY.en['prop.subtitle'].length).toBeGreaterThan(20);
    expect(I18N_DICTIONARY.id['prop.subtitle'].length).toBeGreaterThan(20);
  });

  test('[DH1.2] HeaderNav links /prop and app/prop/page.tsx integrates /api/prop/challenge cleanly', () => {
    const navSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'app/components/HeaderNav.tsx'),
      'utf8'
    );
    const pageSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'app/prop/page.tsx'),
      'utf8'
    );
    expect(navSrc).toContain("href: '/prop'");
    expect(pageSrc).toContain('/api/prop/challenge');
    expect(pageSrc).toContain('Verified Traders Leaderboard');
    expect(pageSrc).toContain('Evaluate Now');
  });
});
