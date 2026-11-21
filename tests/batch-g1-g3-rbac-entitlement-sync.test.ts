import { describe, it, expect, spyOn, afterEach } from 'bun:test';
import { NextRequest } from 'next/server';
import { RbacGuard } from '../packages/auth/rbac-middleware';
import * as sessionMod from '../packages/auth/session';
import { GET as getSession } from '../app/api/auth/session/route';
import { getContractConfiguration } from '../packages/launchpad/web3-provider';

describe('Phase G1–G3 — RBAC Matrix, Capabilities & Plan Entitlement Synchronization', () => {
  const spies: Array<{ mockRestore: () => void }> = [];

  afterEach(() => {
    while (spies.length > 0) {
      spies.pop()?.mockRestore();
    }
  });

  it('G1.1 — RbacGuard.getCapabilitiesForRoles returns exact capabilities for BILLING_ADMIN', () => {
    const caps = RbacGuard.getCapabilitiesForRoles(['BILLING_ADMIN']);
    expect(caps).toContain('VIEW_TOKENS');
    expect(caps).toContain('CONNECT_WALLET');
    expect(caps).toContain('MANAGE_BILLING_PLANS');
    expect(caps).not.toContain('OVERRIDE_RISK_ENGINE');
    expect(caps).not.toContain('PUBLISH_LAUNCH');
  });

  it('G1.2 — RbacGuard.getCapabilitiesForRoles returns all 13 capabilities for SUPER_ADMIN', () => {
    const caps = RbacGuard.getCapabilitiesForRoles(['SUPER_ADMIN']);
    expect(caps.length).toBe(13);
    expect(caps).toContain('OVERRIDE_RISK_ENGINE');
    expect(caps).toContain('MANAGE_SNAPSHOTS');
    expect(caps).toContain('MANAGE_BILLING_PLANS');
  });

  it('G1.3 — GET /api/auth/session returns Guest defaults with empty roles/capabilities and paperTrading entitlement', async () => {
    spies.push(spyOn(sessionMod, 'authenticateSession').mockResolvedValue(null));
    const req = new NextRequest('http://localhost:3000/api/auth/session');
    const res = await getSession(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.authenticated).toBe(false);
    expect(json.data.userRole).toBe('GUEST');
    expect(json.data.roles).toEqual([]);
    expect(json.data.capabilities).toEqual([]);
    expect(json.data.entitlements.paperTrading).toBe(true);
    expect(json.data.entitlements.liveTrading).toBe(false);
    expect(json.data.entitlements.createLaunch).toBe(false);
  });

  it('G1.4 — GET /api/auth/session maps BILLING_ADMIN properly without falling back to TRADER', async () => {
    spies.push(
      spyOn(sessionMod, 'authenticateSession').mockResolvedValue({
        user: { userId: 'usr-billing-01', roles: ['BILLING_ADMIN'], status: 'ACTIVE' },
        walletAddress: '0x000000000000000000000000000000000000b111',
        token: 'mock-token',
        issuedAt: Date.now(),
      })
    );
    const req = new NextRequest('http://localhost:3000/api/auth/session');
    const res = await getSession(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.authenticated).toBe(true);
    expect(json.data.userRole).toBe('BILLING_ADMIN');
    expect(json.data.roles).toContain('BILLING_ADMIN');
    expect(json.data.capabilities).toContain('MANAGE_BILLING_PLANS');
  });

  it('G1.5 — GET /api/auth/session maps RISK_ADMIN properly with FREEZE_TOKEN capability', async () => {
    spies.push(
      spyOn(sessionMod, 'authenticateSession').mockResolvedValue({
        user: { userId: 'usr-risk-01', roles: ['RISK_ADMIN'], status: 'ACTIVE' },
        walletAddress: '0x000000000000000000000000000000000000a15c',
        token: 'mock-token',
        issuedAt: Date.now(),
      })
    );
    const req = new NextRequest('http://localhost:3000/api/auth/session');
    const res = await getSession(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.authenticated).toBe(true);
    expect(json.data.userRole).toBe('RISK_ADMIN');
    expect(json.data.capabilities).toContain('FREEZE_TOKEN');
    expect(json.data.capabilities).toContain('REVIEW_FLAGGED_TOKEN');
  });

  it('G2.1 — getContractConfiguration accepts SSOT launchpadContractAddress override for Token Portal', () => {
    const cfg = getContractConfiguration('0x000000000000000000000000000000000000dEaD');
    expect(cfg.isConfigured).toBe(true);
    expect(cfg.status).toBe('CONFIGURED');
    expect(cfg.contractAddress).toBe('0x000000000000000000000000000000000000dEaD');
  });
});
