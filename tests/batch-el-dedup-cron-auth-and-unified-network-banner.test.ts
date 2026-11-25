import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { isCronAuthorized } from '../packages/auth/cron-auth';
import {
  resolveDefaultBaseChainHex,
  resolveLaunchpadChainHex,
} from '../packages/trading/paper-wallet';

describe('Phase EL — Deduplicated Timing-Safe Cron Auth, Visibility Polling & Unified NetworkMismatchBanner', () => {
  test('isCronAuthorized enforces min 16-char secret and exact Bearer match (timing-safe)', () => {
    const mkReq = (auth: string | null) => ({
      headers: { get: (k: string) => (k.toLowerCase() === 'authorization' ? auth : null) },
    });

    expect(isCronAuthorized(mkReq('Bearer short'), 'short')).toBe(false);
    expect(isCronAuthorized(mkReq(null), 'super_secret_cron_token_12345')).toBe(false);
    expect(isCronAuthorized(mkReq('Bearer wrong_token_12345678'), 'super_secret_cron_token_12345')).toBe(false);
    expect(isCronAuthorized(mkReq('Bearer super_secret_cron_token_12345'), 'super_secret_cron_token_12345')).toBe(true);
  });

  test('zero duplicate function isCronAuthorized definitions remain across all /api/cron/* routes', () => {
    const cronDir = path.join(process.cwd(), 'app/api/cron');
    const entries = fs.readdirSync(cronDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    expect(entries.length).toBeGreaterThanOrEqual(8);

    for (const dir of entries) {
      const routePath = path.join(cronDir, dir.name, 'route.ts');
      const src = fs.readFileSync(routePath, 'utf8');
      expect(src).not.toContain('function isCronAuthorized(');
      expect(src).toContain("from '@packages/auth/cron-auth'");
    }
  });

  test('resolveDefaultBaseChainHex & resolveLaunchpadChainHex map testnet/prod and multi-chain targets deterministically', () => {
    expect(resolveDefaultBaseChainHex('testnet.pndigi.site')).toBe('0x14a34');
    expect(resolveDefaultBaseChainHex('pndigi.site')).toBe('0x2105');
    expect(resolveLaunchpadChainHex('base', 'pndigi.site')).toBe('0x2105');
    expect(resolveLaunchpadChainHex('base', 'testnet.pndigi.site')).toBe('0x14a34');
    expect(resolveLaunchpadChainHex('robinhood')).toBe('0x1237');
    expect(resolveLaunchpadChainHex('arbitrum')).toBe('0xa4b1');
    expect(resolveLaunchpadChainHex('arc')).toBe('0x13b2');
  });

  test('verifies visibility-aware polling in /trading and unified NetworkMismatchBanner across all 4 transactional pages', () => {
    const tradingSrc = fs.readFileSync(path.join(process.cwd(), 'app/trading/page.tsx'), 'utf8');
    const launchpadSrc = fs.readFileSync(path.join(process.cwd(), 'app/launchpad/page.tsx'), 'utf8');
    const kolSrc = fs.readFileSync(path.join(process.cwd(), 'app/kol/page.tsx'), 'utf8');
    const billingSrc = fs.readFileSync(path.join(process.cwd(), 'app/billing/page.tsx'), 'utf8');

    expect(tradingSrc).toContain('document.visibilityState');
    expect(tradingSrc).toContain('<NetworkMismatchBanner');
    expect(launchpadSrc).toContain('<NetworkMismatchBanner');
    expect(kolSrc).toContain('<NetworkMismatchBanner');
    expect(billingSrc).toContain('<NetworkMismatchBanner');
  });
});
