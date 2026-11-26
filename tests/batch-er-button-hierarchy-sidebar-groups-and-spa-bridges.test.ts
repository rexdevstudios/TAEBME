import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';

describe('Batch ER — Button Hierarchy (.btn-pill), Sidebar Groups & Cross-Page SPA Bridges', () => {
  const root = process.cwd();

  it('1. globals.css defines .btn-pill, .btn-pill.active, and sidebar group styles', () => {
    const css = fs.readFileSync(path.join(root, 'app', 'globals.css'), 'utf8');
    expect(css).toContain('.btn-pill {');
    expect(css).toContain('.btn-pill.active {');
    expect(css).toContain('.pons-sidebar-group-label');
    expect(css).toContain('.pons-sidebar-divider');
  });

  it('2. HeaderNav groups navigation into 3 categories while keeping all canonical routes', () => {
    const nav = fs.readFileSync(path.join(root, 'app', 'components', 'HeaderNav.tsx'), 'utf8');
    expect(nav).toContain('navGroups');
    expect(nav).toContain('pons-sidebar-group-label');
    expect(nav).toContain("href: '/trading'");
    expect(nav).toContain("href: '/launchpad'");
    expect(nav).toContain("href: '/kol'");
    expect(nav).toContain("href: '/billing'");
  });

  it('3. /trading uses .btn-pill for selectors and bridges to /agent?symbol=...&tab=analyst via Next Link', () => {
    const trading = fs.readFileSync(path.join(root, 'app', 'trading', 'page.tsx'), 'utf8');
    expect(trading).toContain("import Link from 'next/link';");
    expect(trading).toContain('btn-pill');
    expect(trading).toContain('/agent?symbol=${encodeURIComponent(symbol)}&tab=analyst');
  });

  it('4. /agent hydrates ?symbol= and ?tab= query parameters on mount', () => {
    const agent = fs.readFileSync(path.join(root, 'app', 'agent', 'page.tsx'), 'utf8');
    expect(agent).toContain("qs.get('symbol')");
    expect(agent).toContain("qs.get('tab')");
  });

  it('5. /kol, /billing, and / use Next.js Link for instant SPA cross-page navigation', () => {
    const kol = fs.readFileSync(path.join(root, 'app', 'kol', 'page.tsx'), 'utf8');
    const billing = fs.readFileSync(path.join(root, 'app', 'billing', 'page.tsx'), 'utf8');
    const home = fs.readFileSync(path.join(root, 'app', 'page.tsx'), 'utf8');

    expect(kol).toContain("import Link from 'next/link';");
    expect(kol).toContain('href="/trading"');
    expect(billing).toContain("import Link from 'next/link';");
    expect(billing).toContain('<Link href="/launchpad"');
    expect(home).toContain("import Link from 'next/link';");
    expect(home).toContain('<Link href="/trading"');
  });
});
