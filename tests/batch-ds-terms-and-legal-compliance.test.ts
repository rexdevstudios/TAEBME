/**
 * Unit Suite #86 — Phase DS:
 * Terms of Service, User Agreement & Risk Disclosure (/terms) + Global SiteFooter.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Phase DS — Terms of Service, Risk Disclosure & Global SiteFooter', () => {
  test('app/terms/page.tsx covers all core Web3 non-custodial, no-advice, SBT, Prop Cup, and AS-IS clauses', () => {
    const root = join(import.meta.dir, '..');
    const termsSrc = readFileSync(join(root, 'app/terms/page.tsx'), 'utf8');
    expect(termsSrc).toContain('100% Non-Custodial');
    expect(termsSrc).toContain('No Financial, Investment, Legal, or Tax Advice');
    expect(termsSrc).toContain('Genesis Pioneer SBT');
    expect(termsSrc).toContain('Proof-of-Skill Prop Trading Cup');
    expect(termsSrc).toContain('Emergency Kill-Switch');
    expect(termsSrc).toContain('AS IS');
    expect(termsSrc).toContain('OFAC');
  });

  test('SiteFooter links to /terms and is mounted in app/layout.tsx', () => {
    const root = join(import.meta.dir, '..');
    const footerSrc = readFileSync(join(root, 'app/components/SiteFooter.tsx'), 'utf8');
    expect(footerSrc).toContain('href="/terms"');
    expect(footerSrc).toContain('Terms & Risk Disclosure');

    const layoutSrc = readFileSync(join(root, 'app/layout.tsx'), 'utf8');
    expect(layoutSrc).toContain('<SiteFooter />');
  });
});
