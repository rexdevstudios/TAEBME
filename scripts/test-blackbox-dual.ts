#!/usr/bin/env bun
/**
 * scripts/test-blackbox-dual.ts
 *
 * Dual-Environment Live Blackbox Runner (Phase AN):
 * Reuses `scripts/test-blackbox-suite.ts` against BOTH live deployments sequentially:
 *   1. Testnet:    https://testnet.pndigi.site
 *   2. Production: https://pndigi.site
 * Exits with non-zero code if either environment fails any check.
 */

const TARGETS = [
  { name: 'TESTNET', url: process.env.TESTNET_TARGET_URL || 'https://testnet.pndigi.site' },
  { name: 'PRODUCTION', url: process.env.PROD_TARGET_URL || 'https://pndigi.site' },
] as const;

async function runDualBlackbox() {
  const results: Array<{ name: string; url: string; ok: boolean; durationMs: number }> = [];

  for (const target of TARGETS) {
    console.log(`\n>>> [DUAL BLACKBOX] Running live suite against ${target.name} (${target.url})...\n`);
    const start = Date.now();
    const proc = Bun.spawn(['bun', 'run', 'scripts/test-blackbox-suite.ts'], {
      env: { ...process.env, TEST_TARGET_URL: target.url },
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const exitCode = await proc.exited;
    results.push({
      name: target.name,
      url: target.url,
      ok: exitCode === 0,
      durationMs: Date.now() - start,
    });
  }

  console.log('\n================================================================');
  console.log('  DUAL-ENVIRONMENT BLACKBOX SUMMARY');
  console.log('================================================================');
  for (const r of results) {
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.name.padEnd(10)} ${r.url.padEnd(32)} (${r.durationMs}ms)`);
  }
  console.log('================================================================\n');

  if (results.some((r) => !r.ok)) {
    process.exit(1);
  }
}

runDualBlackbox().catch((err) => {
  console.error('Dual blackbox runner crashed:', err);
  process.exit(1);
});
