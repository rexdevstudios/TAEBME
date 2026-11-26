import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';

describe('Batch ES — Vercel Runtime Log Hygiene & Admin Ops Panel Clarity', () => {
  const root = process.cwd();

  it('1. /api/admin/kill-switch logs expected 400/401/403 rejections via console.warn and reserves console.error for 500 faults', () => {
    const src = fs.readFileSync(
      path.join(root, 'app', 'api', 'admin', 'kill-switch', 'route.ts'),
      'utf8'
    );

    expect(src).toContain("if (isUnauthorized || isForbidden || isBadRequest) {");
    expect(src).toContain("console.warn('[POST /api/admin/kill-switch] Rejected:', message);");
    expect(src).toContain("console.error('[POST /api/admin/kill-switch] Error:', err);");
  });

  it('2. AdminOpsHealthPanel displays staleUnexecutableCount alongside executable pendingExecutionCount', () => {
    const src = fs.readFileSync(
      path.join(root, 'app', 'components', 'AdminOpsHealthPanel.tsx'),
      'utf8'
    );

    expect(src).toContain('staleUnexecutableCount?: number;');
    expect(src).toContain('Stale/Non-CEX:');
  });
});
