// ============================================================================
// AUTH LOGOUT & PRODUCTION/TESTNET PARITY RECONCILIATION TESTS
// ============================================================================
// Verifies restored /api/auth/logout HttpOnly cookie clearing and middleware
// PUBLIC_API_PATHS allowlist without weakening protected API route guards.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { NextRequest } from 'next/server';
import { POST as logoutPOST } from '../app/api/auth/logout/route';
import { middleware } from '../middleware';

describe('Auth Logout Reconciliation (rtrader-production / rtrader-testnet parity)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('POST /api/auth/logout returns 200 and expires HttpOnly rtrader_session cookie', async () => {
    const req = new NextRequest('https://testnet.pndigi.site/api/auth/logout', {
      method: 'POST',
    });
    const res = await logoutPOST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ loggedOut: true });

    const setCookie = res.headers.get('set-cookie') || '';
    expect(setCookie).toContain('rtrader_session=;');
    expect(setCookie).toContain('Max-Age=0');
    expect(setCookie).toContain('Path=/');
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(setCookie.toLowerCase()).toContain('samesite=strict');
  });

  it('POST /api/auth/logout sets Secure flag in NODE_ENV=production', async () => {
    (process.env as Record<string, string>).NODE_ENV = 'production';
    const req = new NextRequest('https://pndigi.site/api/auth/logout', {
      method: 'POST',
    });
    const res = await logoutPOST(req);
    expect(res.status).toBe(200);

    const setCookie = res.headers.get('set-cookie') || '';
    expect(setCookie).toContain('rtrader_session=;');
    expect(setCookie).toContain('Secure');
  });

  it('middleware allows POST /api/auth/logout without session token and sets security headers', async () => {
    const req = new NextRequest('https://pndigi.site/api/auth/logout', {
      method: 'POST',
    });
    const res = await middleware(req);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('middleware still blocks unauthenticated protected routes with 401 UNAUTHORIZED', async () => {
    const req = new NextRequest('https://pndigi.site/api/launchpad/bounty/claim', {
      method: 'POST',
    });
    const res = await middleware(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error?.code).toBe('UNAUTHORIZED');
  });
});
