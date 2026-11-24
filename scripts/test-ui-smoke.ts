/**
 * scripts/test-ui-smoke.ts
 *
 * Dual-Environment Live CEX Launchpad UI & Tab Navigation Smoke Suite (Phase CL).
 * Zero browser binary bloat — audits all 6 core routes on Testnet & Production
 * (or custom TARGET_URL) for HTTP 200, zero Next.js error boundaries, viewport meta,
 * 6 canonical CEX nav links, role="tablist" / role="tab" counts, and CSS stylesheet reachability.
 */

import {
  CEX_UI_ROUTE_CONTRACTS,
  auditRenderedPageHtml,
  extractStylesheetPaths,
} from '../packages/shared/ui-smoke-contract';

async function auditTargetOrigin(origin: string): Promise<{ passed: number; failed: number }> {
  const cleanOrigin = origin.replace(/\/+$/, '');
  console.log(`\n================================================================`);
  console.log(`  UI & CEX TAB SMOKE SUITE: ${cleanOrigin}`);
  console.log(`================================================================`);

  let passed = 0;
  let failed = 0;
  let checkedCss = false;

  for (const contract of CEX_UI_ROUTE_CONTRACTS) {
    const url = `${cleanOrigin}${contract.path}`;
    try {
      const res = await fetch(url, {
        headers: { Accept: 'text/html' },
        signal: AbortSignal.timeout(15000),
      });
      const contentType = res.headers.get('content-type') || '';
      const html = await res.text();

      if (res.status !== 200 || !contentType.includes('text/html')) {
        failed += 1;
        console.error(`  ✗ ${contract.path} — Expected HTTP 200 text/html, got ${res.status} (${contentType})`);
        continue;
      }

      const audit = auditRenderedPageHtml(contract, html);
      if (audit.ok) {
        passed += 1;
        const tabNote = contract.requiresTabList ? ` · tabs=${audit.tabCount}` : '';
        console.log(`  ✓ ${contract.path.padEnd(11)} HTTP 200 · Nav OK · Viewport OK${tabNote} (${contract.label})`);
      } else {
        failed += 1;
        console.error(`  ✗ ${contract.path} FAILED: ${audit.reasons.join(' | ')}`);
      }

      if (!checkedCss) {
        const cssPaths = extractStylesheetPaths(html);
        if (cssPaths.length > 0) {
          checkedCss = true;
          const cssUrl = cssPaths[0].startsWith('http') ? cssPaths[0] : `${cleanOrigin}${cssPaths[0]}`;
          const cssRes = await fetch(cssUrl, { signal: AbortSignal.timeout(10000) });
          if (cssRes.ok) {
            passed += 1;
            console.log(`  ✓ CSS Bundle  HTTP ${cssRes.status} (${cssPaths[0]})`);
          } else {
            failed += 1;
            console.error(`  ✗ CSS Bundle  HTTP ${cssRes.status} (${cssUrl})`);
          }
        }
      }
    } catch (err: any) {
      failed += 1;
      console.error(`  ✗ ${contract.path} NETWORK ERROR: ${err?.message || String(err)}`);
    }
  }

  return { passed, failed };
}

async function main() {
  const customTarget = process.env.TARGET_URL?.trim();
  const targets = customTarget
    ? [customTarget]
    : ['https://testnet.pndigi.site', 'https://pndigi.site'];

  let totalPassed = 0;
  let totalFailed = 0;

  for (const target of targets) {
    const res = await auditTargetOrigin(target);
    totalPassed += res.passed;
    totalFailed += res.failed;
  }

  console.log(`\n================================================================`);
  console.log(`  UI SMOKE SUMMARY: ${totalPassed} PASSED, ${totalFailed} FAILED (${targets.length} env)`);
  console.log(`================================================================\n`);

  if (totalFailed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[UI Smoke] Fatal error:', err);
  process.exit(1);
});
