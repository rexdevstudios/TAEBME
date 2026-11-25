import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { GET as getExecutePendingIntents } from '../app/api/cron/execute-pending-intents/route';
import { runScheduledPulses } from '../workers/cloudflare-autopilot-cron/src/index';
import {
  evaluateOpsPreflightChecklist,
  isServerlessPulseFresh,
} from '../packages/shared/ops-preflight';

describe('Phase EJ — 100% Zero-VPS Serverless Execution (Cloudflare Cron + Vercel sin1/hnd1)', () => {
  test('GET /api/cron/execute-pending-intents fails closed (401) without valid Bearer CRON_SECRET', async () => {
    const req = new NextRequest('https://testnet.pndigi.site/api/cron/execute-pending-intents');
    const res = await getExecutePendingIntents(req);
    expect(res.status).toBe(401);
  });

  test('Cloudflare Worker dispatches 6 pulses including /api/cron/execute-pending-intents when ENABLE_EXECUTION_PULSE=1', async () => {
    const urls: string[] = [];
    const mockFetch: typeof fetch = (async (input: any) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as typeof fetch;

    const results = await runScheduledPulses(
      {
        TESTNET_ORIGIN: 'https://testnet.pndigi.site',
        CRON_SECRET_TESTNET: 'testnet_cron_secret_1234567890',
        PROD_ORIGIN: 'https://pndigi.site',
        CRON_SECRET_PROD: 'prod_cron_secret_1234567890',
        ENABLE_EXECUTION_PULSE: '1',
      },
      mockFetch
    );

    expect(results).toHaveLength(6);
    expect(results.every((r) => r.ok && r.status === 200)).toBe(true);
    expect(urls).toContain('https://testnet.pndigi.site/api/cron/execute-pending-intents');
    expect(urls).toContain('https://pndigi.site/api/cron/execute-pending-intents');
  });

  test('isServerlessPulseFresh validates 15-minute Cloudflare Cron freshness window', () => {
    const now = Date.now();
    expect(isServerlessPulseFresh(new Date(now - 5 * 60_000).toISOString(), 15 * 60_000, now)).toBe(true);
    expect(isServerlessPulseFresh(new Date(now - 20 * 60_000).toISOString(), 15 * 60_000, now)).toBe(false);
    expect(isServerlessPulseFresh(null)).toBe(false);
  });

  test('preflight marks Zero-VPS Cloudflare Cron mode as READY when pulse is fresh', () => {
    const report = evaluateOpsPreflightChecklist({
      dbConnected: true,
      redisConfigured: true,
      activeKillSwitchesCount: 0,
      aiEngine: {
        primaryProvider: 'byteplus',
        byteplusConfigured: true,
        fastPoolCount: 2,
        deepPoolCount: 1,
        infoQuestEnabled: true,
      },
      executionPlane: {
        workerOnline: true,
        mode: 'CLOUDFLARE_CRON',
        pendingExecutionCount: 3,
        lastExecutedAt: null,
        lastPulseAt: new Date().toISOString(),
      },
    });
    expect(report.overallStatus).toBe('READY');
    expect(report.checks.find((c) => c.id === 'EXECUTION_PLANE_WORKER')?.detail).toContain('CLOUDFLARE_CRON');
  });

  test('verifies preferredRegion sin1/hnd1, middleware registration, and wrangler.jsonc ENABLE_EXECUTION_PULSE', () => {
    const routeSrc = fs.readFileSync(
      path.join(process.cwd(), 'app/api/cron/execute-pending-intents/route.ts'),
      'utf8'
    );
    const mwSrc = fs.readFileSync(path.join(process.cwd(), 'middleware.ts'), 'utf8');
    const wranglerSrc = fs.readFileSync(
      path.join(process.cwd(), 'workers/cloudflare-autopilot-cron/wrangler.jsonc'),
      'utf8'
    );

    expect(routeSrc).toContain("preferredRegion = ['sin1', 'hnd1']");
    expect(routeSrc).toContain('agent:execution:last_pulse');
    expect(mwSrc).toContain("'/api/cron/execute-pending-intents'");
    expect(wranglerSrc).toContain('"ENABLE_EXECUTION_PULSE": "1"');
  });
});
