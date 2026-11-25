import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';

describe('Batch EO — CEX Queue Head-of-Line Starvation Guard & Accurate Ops Telemetry', () => {
  const root = process.cwd();

  it('1. execute-pending-intents filters for active binance_credentials and 24h freshness window', () => {
    const routePath = path.join(root, 'app', 'api', 'cron', 'execute-pending-intents', 'route.ts');
    const src = fs.readFileSync(routePath, 'utf8');

    expect(src).toContain("ti.created_at >= NOW() - INTERVAL '24 hours'");
    expect(src).toContain('FROM binance_credentials bc');
    expect(src).toContain('bc.user_id = ti.user_id');
    expect(src).toContain('bc.is_active = true');
  });

  it('2. admin/ops-summary aligns pendingExecutionCount with executable CEX intents and exposes staleUnexecutableCount', () => {
    const opsPath = path.join(root, 'app', 'api', 'admin', 'ops-summary', 'route.ts');
    const src = fs.readFileSync(opsPath, 'utf8');

    expect(src).toContain('staleUnexecutableCount');
    expect(src).toContain('stale_unexec_cnt');
    expect(src).toContain('FROM binance_credentials bc');
    expect(src).toContain("INTERVAL '24 hours'");
  });
});
