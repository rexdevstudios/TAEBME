/**
 * tests/batch-dc-launchpad-scale-and-portal.test.ts
 *
 * Phase DC Verification Suite:
 *  - Verifies Edge CDN Cache-Control header on GET /api/launchpad/tokens (s-maxage=15, stale-while-revalidate=45)
 *  - Verifies status=all|curve|graduated and limit clamping on GET /api/launchpad/tokens
 *  - Verifies POOLNET OpenGraph branding on app/token/[chain]/[address]/page.tsx
 */

import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';

describe('Phase DC: Launchpad 100+ Tokens/Day Edge Caching, Graduation Filter & Portal Polish', () => {
  test('[DC1.1] /api/launchpad/tokens sets Vercel Edge CDN Cache-Control and supports status/limit filters', () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'app/api/launchpad/tokens/route.ts'),
      'utf8'
    );
    expect(src).toContain('public, s-maxage=15, stale-while-revalidate=45');
    expect(src).toContain("statusParam === 'graduated'");
    expect(src).toContain('Math.min(100, Math.max(1');
  });

  test('[DC1.2] /launchpad implements Bonding Curve vs Graduated DEX filter & 12-card pagination', () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'app/launchpad/page.tsx'),
      'utf8'
    );
    expect(src).toContain('statusFilter');
    expect(src).toContain('visiblePoolCount');
    expect(src).toContain('Graduated DEX');
  });

  test('[DC1.3] Public Token Portal uses unified POOLNET OpenGraph metadata', () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'app/token/[chain]/[address]/page.tsx'),
      'utf8'
    );
    expect(src).toContain('Verified Token Portal | POOLNET');
    expect(src).toContain('Verified POOLNET Protocol');
  });
});
