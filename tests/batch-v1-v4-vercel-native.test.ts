import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { NextRequest } from 'next/server';
import { GET as reorgSweepGET } from '../app/api/cron/reorg-sweep/route';
import { middleware } from '../middleware';

describe('Batch V1 & V4 — 100% Vercel-Native Cron Sweeper & Creator Studio UI', () => {
  const root = process.cwd();

  it('GET /api/cron/reorg-sweep fails closed (401) when CRON_SECRET is missing or unauthorized', async () => {
    const prev = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'super-secure-cron-secret-123456';
    try {
      const unauthReq = new NextRequest('https://pndigi.site/api/cron/reorg-sweep');
      const res1 = await reorgSweepGET(unauthReq);
      expect(res1.status).toBe(401);

      const badReq = new NextRequest('https://pndigi.site/api/cron/reorg-sweep', {
        headers: { Authorization: 'Bearer wrong-token' },
      });
      const res2 = await reorgSweepGET(badReq);
      expect(res2.status).toBe(401);
    } finally {
      if (prev === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = prev;
    }
  });

  it('middleware allows /api/cron/reorg-sweep to reach its internal CRON_SECRET guard with security headers', async () => {
    const req = new NextRequest('https://pndigi.site/api/cron/reorg-sweep');
    const res = await middleware(req);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('vercel.json registers both /api/launchpad/keeper and /api/cron/reorg-sweep crons', () => {
    const cfg = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'));
    const paths = (cfg.crons || []).map((c: any) => c.path);
    expect(paths).toContain('/api/launchpad/keeper');
    expect(paths).toContain('/api/cron/reorg-sweep');
  });

  it('CreatorStudioPanel is mounted on app/launchpad/page.tsx and wires asset-studio + growth-pack with zero private keys', () => {
    const pageSrc = readFileSync(join(root, 'app/launchpad/page.tsx'), 'utf8');
    const panelSrc = readFileSync(join(root, 'app/components/CreatorStudioPanel.tsx'), 'utf8');
    expect(pageSrc).toContain('<CreatorStudioPanel');
    expect(panelSrc).toContain('/api/launchpad/asset-studio');
    expect(panelSrc).toContain('/api/launchpad/growth-pack');
    expect(panelSrc).not.toContain('PRIVATE_KEY');
  });
});
