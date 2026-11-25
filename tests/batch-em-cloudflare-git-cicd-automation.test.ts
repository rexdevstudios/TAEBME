import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

describe('Phase EM — Cloud-Native Cloudflare Worker Git CI/CD Auto-Deploy', () => {
  test('workflow YAML enforces pre-deploy unit test gate, graceful secret check, and wrangler deploy', () => {
    const wfPath = path.join(process.cwd(), '.github/workflows/deploy-cloudflare-cron.yml');
    const src = fs.readFileSync(wfPath, 'utf8');

    expect(src).toContain('workflow_dispatch:');
    expect(src).toContain('workers/cloudflare-autopilot-cron/**');
    expect(src).toContain('tests/batch-bo-cron-autopilot-tick-and-cf-worker.test.ts');
    expect(src).toContain('tests/batch-ej-zero-vps-cloudflare-serverless-execution.test.ts');
    expect(src).toContain('secrets.CLOUDFLARE_API_TOKEN');
    expect(src).toContain('secrets.CLOUDFLARE_ACCOUNT_ID');
    expect(src).toContain('cloudflare/wrangler-action@v3');
    expect(src).toContain('workingDirectory: workers/cloudflare-autopilot-cron');
    // Zero hardcoded secrets invariant
    expect(src).not.toMatch(/sk-[a-zA-Z0-9]{20,}/);
  });

  test('wrangler.jsonc remains configured for 5-minute Zero-VPS execution pulses', () => {
    const wranglerPath = path.join(process.cwd(), 'workers/cloudflare-autopilot-cron/wrangler.jsonc');
    const cfg = JSON.parse(fs.readFileSync(wranglerPath, 'utf8'));

    expect(cfg.name).toBe('rtrader-autopilot-cron');
    expect(cfg.triggers?.crons).toEqual(['*/5 * * * *']);
    expect(cfg.vars?.ENABLE_EXECUTION_PULSE).toBe('1');
    expect(cfg.vars?.TESTNET_ORIGIN).toBe('https://testnet.pndigi.site');
    expect(cfg.vars?.PROD_ORIGIN).toBe('https://pndigi.site');
  });
});
