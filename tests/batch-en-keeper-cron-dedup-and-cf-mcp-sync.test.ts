import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';

describe('Batch EN — Keeper Cron Auth Deduplication & Legacy Schedule Cleanup', () => {
  const root = process.cwd();

  it('1. app/api/launchpad/keeper/route.ts reuses @packages/auth/cron-auth (no duplicated local isCronAuthorized)', () => {
    const keeperPath = path.join(root, 'app', 'api', 'launchpad', 'keeper', 'route.ts');
    const src = fs.readFileSync(keeperPath, 'utf8');

    expect(src).toContain("from '@packages/auth/cron-auth'");
    expect(src).not.toContain('function isCronAuthorized(');
  });

  it('2. .github/workflows/keeper-cron.yml removes legacy */30 schedule and dead rtrader.vercel.app fallback', () => {
    const wfPath = path.join(root, '.github', 'workflows', 'keeper-cron.yml');
    const yaml = fs.readFileSync(wfPath, 'utf8');

    expect(yaml).toContain('workflow_dispatch:');
    expect(yaml).not.toContain('schedule:');
    expect(yaml).not.toContain('rtrader.vercel.app');
    expect(yaml).toContain('https://pndigi.site');
  });

  it('3. All 9 cron routes across app/api/cron and app/api/launchpad/keeper share the single timing-safe cron-auth helper', () => {
    const cronRoutes = [
      'app/api/cron/agent-scout-sync/route.ts',
      'app/api/cron/autopilot-tick/route.ts',
      'app/api/cron/execute-pending-intents/route.ts',
      'app/api/cron/genesis-digest/route.ts',
      'app/api/cron/kol-consensus-archive/route.ts',
      'app/api/cron/market-sync/route.ts',
      'app/api/cron/reconcile-orders/route.ts',
      'app/api/cron/reorg-sweep/route.ts',
      'app/api/launchpad/keeper/route.ts',
    ];

    for (const rel of cronRoutes) {
      const src = fs.readFileSync(path.join(root, rel), 'utf8');
      expect(src).toContain("from '@packages/auth/cron-auth'");
      expect(src).not.toContain('function isCronAuthorized(');
    }
  });
});
