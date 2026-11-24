/**
 * Unit Suite #81 — Phase DN:
 * Automated Weekly Genesis Referral & Prop Cup Digest Cron (/api/cron/genesis-digest).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { formatWeeklyGenesisDigestMessage } from '../packages/billing/genesis-sbt';
import { GET as getGenesisDigest } from '../app/api/cron/genesis-digest/route';

describe('Phase DN — Weekly Genesis Referral Digest Cron', () => {
  test('formatWeeklyGenesisDigestMessage formats active progress, Top 5 referrers, and SOLD OUT state', () => {
    const msg = formatWeeklyGenesisDigestMessage({
      totalMinted: 250,
      supplyCap: 10000,
      verifiedPropTraders: 7,
      leaderboard: [
        {
          walletAddress: '0x111111111111111111111111111111111111abcd',
          referralsCount: 12,
          bonusCreditsEarned: 600,
        },
      ],
      siteOrigin: 'https://pndigi.site',
    });

    expect(msg).toContain('FREE MINT LIVE');
    expect(msg).toContain('250 / 10,000 (2.5%)');
    expect(msg).toContain('Verified Prop Cup Traders: 7');
    expect(msg).toContain('0x1111...abcd');
    expect(msg).toContain('12 invites (+600 cr)');
    expect(msg).toContain('https://pndigi.site/transparency');

    const soldOutMsg = formatWeeklyGenesisDigestMessage({
      totalMinted: 10000,
      supplyCap: 10000,
      leaderboard: [],
    });
    expect(soldOutMsg).toContain('SOLD OUT (CAP LOCKED)');
    expect(soldOutMsg).toContain('Be the first referrer');
  });

  test('GET /api/cron/genesis-digest fails closed (401) without valid CRON_SECRET and supports dryRun=1 when authorized', async () => {
    const prevSecret = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'super-secret-cron-token-12345';
    try {
      const unauthReq = new NextRequest('https://pndigi.site/api/cron/genesis-digest');
      const unauthRes = await getGenesisDigest(unauthReq);
      expect(unauthRes.status).toBe(401);

      const dryReq = new NextRequest('https://pndigi.site/api/cron/genesis-digest?dryRun=1', {
        headers: { authorization: 'Bearer super-secret-cron-token-12345' },
      });
      const dryRes = await getGenesisDigest(dryReq);
      expect(dryRes.status).toBe(200);
      const body = await dryRes.json();
      expect(body.success).toBe(true);
      expect(body.data.dryRun).toBe(true);
      expect(body.data.dispatched).toBe(false);
      expect(body.data.preview).toContain('POOLNET Weekly Genesis Sprint Digest');
    } finally {
      if (prevSecret !== undefined) process.env.CRON_SECRET = prevSecret;
      else delete process.env.CRON_SECRET;
    }
  });

  test('middleware.ts and vercel.json register /api/cron/genesis-digest cleanly', () => {
    const root = join(import.meta.dir, '..');
    const mw = readFileSync(join(root, 'middleware.ts'), 'utf8');
    expect(mw).toContain("'/api/cron/genesis-digest'");

    const vj = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'));
    const entry = (vj.crons || []).find((c: any) => c.path === '/api/cron/genesis-digest');
    expect(entry).toBeDefined();
    expect(entry.schedule).toBe('0 12 * * 1');
  });
});
