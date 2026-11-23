import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as getAutoPilotCronTick } from '../app/api/cron/autopilot-tick/route';
import { runScheduledPulses } from '../workers/cloudflare-autopilot-cron/src/index';

describe('Phase BO — Stateless /api/cron/autopilot-tick & Cloudflare Worker Cron Scheduler', () => {
  it('[BO1.1] GET /api/cron/autopilot-tick fails closed (401) without valid Bearer CRON_SECRET', async () => {
    const req = new NextRequest('https://testnet.pndigi.site/api/cron/autopilot-tick');
    const res = await getAutoPilotCronTick(req);
    expect(res.status).toBe(401);
  });

  it('[BO2.1] Cloudflare Worker runScheduledPulses dispatches Scout + Auto-Pilot ticks to configured origins with Bearer secret', async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const mockFetch: typeof fetch = (async (input: any, init?: any) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), auth: headers.get('authorization') });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as typeof fetch;

    const results = await runScheduledPulses(
      {
        TESTNET_ORIGIN: 'https://testnet.pndigi.site',
        CRON_SECRET_TESTNET: 'testnet_cron_secret_1234567890',
        PROD_ORIGIN: 'https://pndigi.site',
        CRON_SECRET_PROD: 'prod_cron_secret_1234567890',
      },
      mockFetch
    );

    expect(results).toHaveLength(4);
    expect(results.every((r) => r.ok && r.status === 200)).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([
      'https://testnet.pndigi.site/api/cron/agent-scout-sync',
      'https://testnet.pndigi.site/api/cron/autopilot-tick',
      'https://pndigi.site/api/cron/agent-scout-sync',
      'https://pndigi.site/api/cron/autopilot-tick',
    ]);
    expect(calls[0].auth).toBe('Bearer testnet_cron_secret_1234567890');
    expect(calls[2].auth).toBe('Bearer prod_cron_secret_1234567890');
  });
});
