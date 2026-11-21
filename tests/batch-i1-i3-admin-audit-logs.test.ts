import { describe, it, expect, spyOn, afterEach } from 'bun:test';
import { NextRequest } from 'next/server';
import * as sessionMod from '../packages/auth/session';
import { GET as getAdminAuditLogs } from '../app/api/admin/audit-logs/route';

describe('Phase I1–I3 — Admin Governance Audit Logs SSOT Endpoint', () => {
  const spies: Array<{ mockRestore: () => void }> = [];

  afterEach(() => {
    while (spies.length > 0) {
      spies.pop()?.mockRestore();
    }
  });

  it('I1.1 — GET /api/admin/audit-logs fails closed (401) without SIWE session', async () => {
    const req = new NextRequest('http://localhost:3000/api/admin/audit-logs');
    const res = await getAdminAuditLogs(req);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it('I1.2 — GET /api/admin/audit-logs rejects non-admin roles (TRADER / CREATOR) with 403', async () => {
    spies.push(
      spyOn(sessionMod, 'requireActiveSession').mockResolvedValue({
        user: { userId: 'usr-trader-01', roles: ['TRADER', 'CREATOR'], status: 'ACTIVE' },
        walletAddress: '0x000000000000000000000000000000000000dEaD',
        token: 'mock-token',
        issuedAt: Date.now(),
      })
    );
    const req = new NextRequest('http://localhost:3000/api/admin/audit-logs');
    const res = await getAdminAuditLogs(req);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error?.code).toBe('FORBIDDEN');
  });

  it('I1.3 — GET /api/admin/audit-logs returns 200 + structured entries array for SUPER_ADMIN & BILLING_ADMIN', async () => {
    spies.push(
      spyOn(sessionMod, 'requireActiveSession').mockResolvedValue({
        user: { userId: 'usr-billing-admin', roles: ['BILLING_ADMIN'], status: 'ACTIVE' },
        walletAddress: '0x0c9f4a82b5ae258e8e65ca40ac4f1abc455c34b6',
        token: 'mock-token',
        issuedAt: Date.now(),
      })
    );
    const req = new NextRequest('http://localhost:3000/api/admin/audit-logs?limit=15&action=BILLING');
    const res = await getAdminAuditLogs(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(Array.isArray(json.data.entries)).toBe(true);
    expect(typeof json.data.count).toBe('number');
  });
});
