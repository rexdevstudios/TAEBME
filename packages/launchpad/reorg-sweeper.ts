// ============================================================================
// POST-PUBLICATION REORG SWEEPER (VERCEL CRON & EXECUTION PLANE SHARED CORE)
// ============================================================================
// Pure read-only RPC verification (ZERO private keys, ZERO while(true) loops).
// Audits active PUBLISHED snapshots against BondingCurveLaunchpad.bountyMerkleRoots.
//
// Invariants:
// - RPC errors / timeouts / chain mismatches are classified as INCONCLUSIVE
//   (never false-positive reorg).
// - Only an explicit on-chain root divergence transitions PUBLISHED -> REORG_DETECTED
//   via db.markSnapshotReorgDetected (enforcing SEC-08).
// ============================================================================

import { ethers } from 'ethers';

export interface PublishedSnapshotForSweep {
  id: string;
  token_address: string;
  contract_address: string;
  network_id: string;
  chain_id: bigint;
  merkle_root: string;
  confirmed_block_number: bigint | null;
}

export interface ReorgSweeperDbAdapter {
  listActivePublishedSnapshots(networkId?: string): Promise<PublishedSnapshotForSweep[]>;
  markSnapshotReorgDetected(snapshotId: string, reason: string): Promise<void>;
}

export interface ReorgSweeperRpcProvider {
  getNetwork(): Promise<{ chainId: bigint }>;
  call(tx: { to: string; data: string }): Promise<string>;
}

export interface SweepReport {
  checked: number;
  consistent: number;
  reorgDetected: string[];
  inconclusive: Array<{ snapshotId: string; error: string }>;
}

const MERKLE_ROOT_IFACE = new ethers.Interface([
  'function bountyMerkleRoots(address tokenAddress) view returns (bytes32)',
]);

export class PublishedSnapshotReorgSweeper {
  constructor(
    private readonly db: ReorgSweeperDbAdapter,
    private readonly providerForNetwork: (networkId: string) => Promise<ReorgSweeperRpcProvider>
  ) {}

  async sweepOnce(networkId?: string): Promise<SweepReport> {
    const snapshots = await this.db.listActivePublishedSnapshots(networkId);
    const report: SweepReport = {
      checked: snapshots.length,
      consistent: 0,
      reorgDetected: [],
      inconclusive: [],
    };

    for (const snap of snapshots) {
      try {
        const provider = await this.providerForNetwork(snap.network_id);
        const net = await provider.getNetwork();
        if (BigInt(net.chainId) !== snap.chain_id) {
          report.inconclusive.push({
            snapshotId: snap.id,
            error: `CHAIN_ID_MISMATCH: expected ${snap.chain_id}, got ${net.chainId}`,
          });
          continue;
        }

        const calldata = MERKLE_ROOT_IFACE.encodeFunctionData('bountyMerkleRoots', [
          ethers.getAddress(snap.token_address),
        ]);
        const raw = await provider.call({ to: ethers.getAddress(snap.contract_address), data: calldata });
        const [onChainRoot] = MERKLE_ROOT_IFACE.decodeFunctionResult('bountyMerkleRoots', raw);
        const normalizedOnChain = String(onChainRoot).toLowerCase();
        const normalizedExpected = snap.merkle_root.toLowerCase();

        if (normalizedOnChain === normalizedExpected) {
          report.consistent += 1;
        } else {
          const reason = `POST_PUBLICATION_ROOT_DIVERGENCE: on-chain root ${normalizedOnChain} != published snapshot root ${normalizedExpected}`;
          await this.db.markSnapshotReorgDetected(snap.id, reason);
          report.reorgDetected.push(snap.id);
        }
      } catch (err: unknown) {
        report.inconclusive.push({
          snapshotId: snap.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return report;
  }
}
