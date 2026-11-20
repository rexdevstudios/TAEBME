import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { BONDING_CURVE_LAUNCHPAD_ABI } from '../packages/launchpad/contracts/BondingCurveLaunchpadAbi';

describe('Batch U3-B — Admin Bounty Merkle Snapshot UI & ABI Contract Verification', () => {
  const root = process.cwd();

  it('ABI exposes setBountyMerkleRoot(address,bytes32) nonpayable', () => {
    const fn = (BONDING_CURVE_LAUNCHPAD_ABI as any[]).find(
      (entry) => entry.type === 'function' && entry.name === 'setBountyMerkleRoot'
    );
    expect(fn).toBeDefined();
    expect(fn.stateMutability).toBe('nonpayable');
    expect(fn.inputs).toHaveLength(2);
    expect(fn.inputs[0].type).toBe('address');
    expect(fn.inputs[1].type).toBe('bytes32');
  });

  it('app/launchpad/page.tsx gates AdminMerkleSnapshotPanel strictly on MANAGE_SNAPSHOTS roles (SUPER_ADMIN | LAUNCH_ADMIN)', () => {
    const pageSrc = readFileSync(join(root, 'app/launchpad/page.tsx'), 'utf8');
    expect(pageSrc).toContain("import { AdminMerkleSnapshotPanel } from '../components/AdminMerkleSnapshotPanel'");
    expect(pageSrc).toContain("(userRole === 'SUPER_ADMIN' || userRole === 'LAUNCH_ADMIN')");
    expect(pageSrc).toContain('<AdminMerkleSnapshotPanel');
  });

  it('AdminMerkleSnapshotPanel wires all 4 admin snapshot routes and MetaMask setBountyMerkleRoot without private keys', () => {
    const panelSrc = readFileSync(join(root, 'app/components/AdminMerkleSnapshotPanel.tsx'), 'utf8');
    expect(panelSrc).toContain('/api/admin/launchpad/snapshots/draft');
    expect(panelSrc).toContain('/api/admin/launchpad/snapshots/finalize');
    expect(panelSrc).toContain('/api/admin/launchpad/snapshots/confirm-publish');
    expect(panelSrc).toContain('/api/admin/launchpad/snapshots/publish-intent');
    expect(panelSrc).toContain('setBountyMerkleRoot');
    expect(panelSrc).not.toContain('PRIVATE_KEY');
    expect(panelSrc).not.toContain('ethers.Wallet(');
  });
});
