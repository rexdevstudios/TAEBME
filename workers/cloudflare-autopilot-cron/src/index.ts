/**
 * workers/cloudflare-autopilot-cron/src/index.ts
 *
 * Free-Tier Cloudflare Worker Cron Scheduler (every 5m -> 288 ticks/day, <0.3% of free quota).
 * - Holds ZERO database credentials, ZERO private keys, and ZERO user CEX API keys.
 * - Only dispatches authenticated Bearer <CRON_SECRET> pulses to Vercel stateless cron endpoints:
 *     1. GET /api/cron/agent-scout-sync
 *     2. GET /api/cron/autopilot-tick
 */

export interface CronWorkerEnv {
  TESTNET_ORIGIN?: string;
  PROD_ORIGIN?: string;
  CRON_SECRET_TESTNET?: string;
  CRON_SECRET_PROD?: string;
  ENABLE_EXECUTION_PULSE?: string;
}

export interface CronPulseResult {
  target: string;
  path: string;
  ok: boolean;
  status: number;
  error?: string;
}

export async function dispatchCronPulse(
  origin: string,
  path: string,
  secret: string,
  fetchImpl: typeof fetch = fetch
): Promise<CronPulseResult> {
  const cleanOrigin = origin.replace(/\/+$/, '');
  const url = `${cleanOrigin}${path}`;
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${secret}`,
        'User-Agent': 'rtrader-autopilot-cron/1.0',
      },
      signal: AbortSignal.timeout(10000),
    });
    return { target: cleanOrigin, path, ok: res.ok, status: res.status };
  } catch (err: unknown) {
    return {
      target: cleanOrigin,
      path,
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : 'FETCH_ERROR',
    };
  }
}

export async function runScheduledPulses(
  env: CronWorkerEnv,
  fetchImpl: typeof fetch = fetch
): Promise<CronPulseResult[]> {
  const tasks: Array<Promise<CronPulseResult>> = [];
  const paths = ['/api/cron/agent-scout-sync', '/api/cron/autopilot-tick'];
  if (String(env.ENABLE_EXECUTION_PULSE || '').trim() === '1') {
    paths.push('/api/cron/execute-pending-intents');
  }

  if (env.TESTNET_ORIGIN && env.CRON_SECRET_TESTNET && env.CRON_SECRET_TESTNET.trim().length >= 16) {
    for (const p of paths) {
      tasks.push(dispatchCronPulse(env.TESTNET_ORIGIN, p, env.CRON_SECRET_TESTNET.trim(), fetchImpl));
    }
  }

  if (env.PROD_ORIGIN && env.CRON_SECRET_PROD && env.CRON_SECRET_PROD.trim().length >= 16) {
    for (const p of paths) {
      tasks.push(dispatchCronPulse(env.PROD_ORIGIN, p, env.CRON_SECRET_PROD.trim(), fetchImpl));
    }
  }

  return Promise.all(tasks);
}

const worker = {
  async fetch(): Promise<Response> {
    return new Response(
      JSON.stringify({
        ok: true,
        service: 'rtrader-autopilot-cron',
        schedule: '*/5 * * * *',
        timestamp: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  },

  async scheduled(
    controller: { scheduledTime: number; cron: string },
    env: CronWorkerEnv,
    ctx: { waitUntil(promise: Promise<unknown>): void }
  ): Promise<void> {
    ctx.waitUntil(
      runScheduledPulses(env).then((results) => {
        console.log(
          JSON.stringify({
            event: 'AUTOPILOT_CRON_PULSE_COMPLETE',
            cron: controller.cron,
            scheduledTime: new Date(controller.scheduledTime).toISOString(),
            results,
          })
        );
      })
    );
  },
};

export default worker;
