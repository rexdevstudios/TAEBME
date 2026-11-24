import { describe, expect, it } from 'bun:test';
import {
  CEX_UI_ROUTE_CONTRACTS,
  auditRenderedPageHtml,
  extractStylesheetPaths,
} from '../packages/shared/ui-smoke-contract';

const SAMPLE_VALID_LAUNCHPAD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="stylesheet" href="/_next/static/css/app-main.css" />
</head>
<body>
  <header class="header-nav">
    <a href="/">POOLNET</a>
    <nav>
      <a href="/">Overview</a>
      <a href="/launchpad">Launchpad</a>
      <a href="/trading">Trade</a>
      <a href="/agent">AI Auto-Pilot</a>
      <a href="/kol">Earn &amp; KOL</a>
      <a href="/transparency">Transparency</a>
      <a href="/billing">Account</a>
    </nav>
  </header>
  <main>
    <h1>Token Launchpad &amp; Live Bonding Pools</h1>
    <div role="tablist" class="cex-tab-bar">
      <button role="tab" class="cex-tab-btn active">Live Pools</button>
      <button role="tab" class="cex-tab-btn">Launch Token</button>
      <button role="tab" class="cex-tab-btn">AI Brand Studio</button>
    </div>
  </main>
</body>
</html>`;

describe('Phase CL: Automated CEX UI & Tab Navigation Smoke Contract', () => {
  it('CL1.1 validates healthy CEX Launchpad SSR HTML with all 6 nav links, viewport, and >= 3 tabs', () => {
    const launchpadContract = CEX_UI_ROUTE_CONTRACTS.find((c) => c.path === '/launchpad')!;
    const result = auditRenderedPageHtml(launchpadContract, SAMPLE_VALID_LAUNCHPAD_HTML);

    expect(result.ok).toBe(true);
    expect(result.hasHeaderNav).toBe(true);
    expect(result.hasViewportMeta).toBe(true);
    expect(result.hasTabList).toBe(true);
    expect(result.tabCount).toBe(3);
    expect(result.reasons).toEqual([]);
  });

  it('CL1.2 flags Next.js fatal error boundary and missing role="tablist" deterministically', () => {
    const tradingContract = CEX_UI_ROUTE_CONTRACTS.find((c) => c.path === '/trading')!;
    const brokenHtml = `<html><head></head><body><div id="__next_error__">Application error: a client-side exception</div></body></html>`;
    const result = auditRenderedPageHtml(tradingContract, brokenHtml);

    expect(result.ok).toBe(false);
    expect(result.fatalErrors.length).toBeGreaterThan(0);
    expect(result.hasTabList).toBe(false);
    expect(result.hasViewportMeta).toBe(false);
  });

  it('CL1.3 extracts stylesheet paths accurately from Next.js HTML head', () => {
    const css = extractStylesheetPaths(SAMPLE_VALID_LAUNCHPAD_HTML);
    expect(css).toEqual(['/_next/static/css/app-main.css']);
  });
});
