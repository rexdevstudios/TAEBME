import { describe, expect, it } from 'bun:test';
import { DualControlManager } from '../packages/admin/dual-control';
import { PostgresDualControlDbAdapter } from '../packages/db/dual-control-repo';

describe('Phase AW: SOP-07 Dual-Control Governance Propose -> Approve -> Consume Workflow', () => {
  it('[AW1.1] Propose request persists enriched payload with reason and lists in listRecentRequests', async () => {
    const repo = new PostgresDualControlDbAdapter({
      getDbPool: () => null,
      ensureUserEntity: async (_p, id) => id,
      isUuid: () => true,
    });

    const created = await DualControlManager.requestAction(
      'OVERRIDE_RISK',
      'admin-proposer-01',
      { scope: 'GLOBAL', killSwitchAction: 'ACTIVATE' },
      'Emergency volatility circuit breaker',
      repo
    );

    expect(created.id.length).toBeGreaterThan(10);
    expect(created.status).toBe('PENDING');
    expect(created.payload.scope).toBe('GLOBAL');
    expect(created.payload.reason).toBe('Emergency volatility circuit breaker');

    const recent = await repo.listRecentRequests(10);
    expect(recent.length).toBe(1);
    expect(recent[0].id).toBe(created.id);
    expect(recent[0].reason).toBe('Emergency volatility circuit breaker');
  });

  it('[AW1.2] Strictly blocks self-approval by proposer and allows secondary admin approval + atomic CAS execution', async () => {
    const repo = new PostgresDualControlDbAdapter({
      getDbPool: () => null,
      ensureUserEntity: async (_p, id) => id,
      isUuid: () => true,
    });

    const created = await DualControlManager.requestAction(
      'OVERRIDE_RISK',
      'admin-alpha',
      { scope: 'AGENT', killSwitchAction: 'ACTIVATE' },
      'Halt autonomous agent execution',
      repo
    );

    // Self-approval by admin-alpha must fail
    await expect(
      DualControlManager.approveAction(created.id, 'admin-alpha', repo)
    ).rejects.toThrow('DUAL_CONTROL_SELF_APPROVAL_FORBIDDEN');

    // Approval by distinct admin-beta must succeed
    const approved = await DualControlManager.approveAction(created.id, 'admin-beta', repo);
    expect(approved.status).toBe('APPROVED');
    expect(approved.approvedBy).toBe('admin-beta');

    // Consume approved request atomically
    const consumed = await DualControlManager.consumeApprovedRequest(
      created.id,
      'OVERRIDE_RISK',
      'AGENT',
      'admin-super',
      repo
    );
    expect(consumed.status).toBe('EXECUTED');

    // Second replay must be rejected
    await expect(
      DualControlManager.consumeApprovedRequest(created.id, 'OVERRIDE_RISK', 'AGENT', 'admin-super', repo)
    ).rejects.toThrow('DUAL_CONTROL_ALREADY_EXECUTED');
  });
});
