// ============================================================================
// BATCH U3 — SNAPSHOT SQL TRIGGER PARITY & CONFIRM-PUBLISH VERIFICATION TESTS
// ============================================================================
// Verifies Audit-First SQL fixes:
// 1. finalizeSnapshotTransaction updates recipients BEFORE flipping header to FINALIZED
//    (required by SQL trigger trg_bmsr_mutation_guard).
// 2. publish-intent INSERT matches bounty_merkle_publication_intents schema
//    (no nonexistent launch_id, includes required idempotency_key, resolves UUID created_by).
// 3. confirm-publish enforces MANAGE_SNAPSHOTS RBAC (401 unauthenticated, 403 non-admin)
//    and validates snapshotId / txHash inputs fail-closed.
// ============================================================================

import { describe, it, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import { POST as confirmPublishPOST } from '../app/api/admin/launchpad/snapshots/confirm-publish/route';
import { createSessionToken } from '../packages/auth/session';

const ROOT = path.resolve(import.meta.dir, '..');

describe('Batch U3 — Snapshot SQL Parity & Vercel-First Confirm-Publish', () => {
  it('S-4: finalizeSnapshotTransaction updates recipients BEFORE setting header status = FINALIZED', () => {
    const dbPoolSrc = fs.readFileSync(path.join(ROOT, 'packages/shared/db-pool.ts'), 'utf8');
    const fnStart = dbPoolSrc.indexOf('async finalizeSnapshotTransaction(');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = dbPoolSrc.slice(fnStart, fnStart + 1800);

    const recipientsUpdateIdx = fnBody.indexOf('UPDATE bounty_merkle_snapshot_recipients');
    const headerFinalizeIdx = fnBody.indexOf("SET status = 'FINALIZED'");
    expect(recipientsUpdateIdx).toBeGreaterThan(-1);
    expect(headerFinalizeIdx).toBeGreaterThan(-1);
    expect(recipientsUpdateIdx).toBeLessThan(headerFinalizeIdx);
  });

  it('S-1/S-2/S-3: publish-intent INSERT omits nonexistent launch_id, includes idempotency_key, and uses ensureUserEntity', () => {
    const routeSrc = fs.readFileSync(
      path.join(ROOT, 'app/api/admin/launchpad/snapshots/publish-intent/route.ts'),
      'utf8'
    );
    const insertStart = routeSrc.indexOf('INSERT INTO bounty_merkle_publication_intents');
    expect(insertStart).toBeGreaterThan(-1);
    const insertBlock = routeSrc.slice(insertStart, insertStart + 400);

    expect(insertBlock).not.toContain('launch_id');
    expect(insertBlock).toContain('idempotency_key');
    expect(routeSrc).toContain('ensureUserEntity(pool, session.walletAddress)');
  });

  it('S-6: PostgresBountyMerkleSnapshotDbAdapter implements markSnapshotPublished with SUPERSEDED rotation', () => {
    const dbPoolSrc = fs.readFileSync(path.join(ROOT, 'packages/shared/db-pool.ts'), 'utf8');
    const fnStart = dbPoolSrc.indexOf('async markSnapshotPublished(');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = dbPoolSrc.slice(fnStart, fnStart + 2000);
    expect(fnBody).toContain("SET status = 'SUPERSEDED'");
    expect(fnBody).toContain("SET status = 'PUBLISHED'");
    expect(fnBody).toContain('publication_tx_hash');
  });

  it('U3-1: POST /api/admin/launchpad/snapshots/confirm-publish rejects unauthenticated request with 401', async () => {
    const req = new NextRequest('https://testnet.pndigi.site/api/admin/launchpad/snapshots/confirm-publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshotId: 'snap-1', txHash: '0x' + 'a'.repeat(64) }),
    });
    const res = await confirmPublishPOST(req);
    expect(res.status).toBe(401);
  });

  it('U3-2: POST /api/admin/launchpad/snapshots/confirm-publish rejects TRADER role with 403 FORBIDDEN', async () => {
    const traderToken = createSessionToken({
      userId: 'usr-0x11111111',
      walletAddress: '0x1111111111111111111111111111111111111111',
    });
    const req = new NextRequest('https://testnet.pndigi.site/api/admin/launchpad/snapshots/confirm-publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${traderToken}`,
      },
      body: JSON.stringify({ snapshotId: 'snap-1', txHash: '0x' + 'a'.repeat(64) }),
    });
    const res = await confirmPublishPOST(req);
    expect(res.status).toBe(403);
  });

  it('U3-3: POST /api/admin/launchpad/snapshots/confirm-publish validates txHash format fail-closed (400)', async () => {
    // Non-production test admin allowlist wallet from packages/auth/session.ts L191
    const adminToken = createSessionToken({
      userId: 'usr-0x90f79bf6',
      walletAddress: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
    });
    const req = new NextRequest('https://testnet.pndigi.site/api/admin/launchpad/snapshots/confirm-publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ snapshotId: 'snap-1', txHash: 'invalid-hash' }),
    });
    const res = await confirmPublishPOST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('INVALID_TX_HASH');
  });
});
