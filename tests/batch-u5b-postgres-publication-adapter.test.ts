import { describe, it, expect } from 'bun:test';
import { ethers } from 'ethers';
import { PostgresPublicationWorkerDbAdapter } from '../apps/execution-plane/workers/postgres-publication-worker-db-adapter';
import { PublishedSnapshotReorgSweeper } from '../apps/execution-plane/workers/published-snapshot-reorg-sweeper';

describe('Batch U5-B — PostgresPublicationWorkerDbAdapter (B3.4) & Reorg Sweeper (B3.5)', () => {
  const ROOT_A = '0x' + 'a'.repeat(64);
  const ROOT_B = '0x' + 'b'.repeat(64);
  const TOKEN = '0x1111111111111111111111111111111111111111';
  const CONTRACT = '0x2222222222222222222222222222222222222222';
  const SIGNER = '0x3333333333333333333333333333333333333333';

  it('claimNextPendingIntent uses FOR UPDATE OF bmpi SKIP LOCKED and maps expected_root -> merkle_root', async () => {
    const executedSql: string[] = [];
    const mockClient = {
      query: async (sql: string) => {
        executedSql.push(sql);
        if (sql.includes('FOR UPDATE OF bmpi SKIP LOCKED')) {
          return {
            rows: [
              {
                id: 'intent-1',
                idempotency_key: 'publish-intent:snap-1',
                snapshot_id: 'snap-1',
                token_address: TOKEN,
                network_id: 'base-sepolia',
                chain_id: '84532',
                contract_address: CONTRACT,
                expected_root: ROOT_A,
                status: 'CREATED',
                created_at: new Date(),
                updated_at: new Date(),
              },
            ],
          };
        }
        return { rows: [] };
      },
      release: () => {},
    };
    const mockPool = { connect: async () => mockClient, query: mockClient.query } as any;

    const adapter = new PostgresPublicationWorkerDbAdapter(mockPool);
    const claimed = await adapter.claimNextPendingIntent('base-sepolia', CONTRACT);

    expect(claimed).not.toBeNull();
    expect(claimed!.merkle_root).toBe(ROOT_A);
    expect(claimed!.status).toBe('PENDING');
    expect(executedSql.some((s) => s.includes('FOR UPDATE OF bmpi SKIP LOCKED'))).toBe(true);
  });

  it('reserveNonce uses pg_advisory_xact_lock and rejects duplicate reservation atomically (SEC-03)', async () => {
    const executedSql: string[] = [];
    const mockClient = {
      query: async (sql: string) => {
        executedSql.push(sql);
        return { rows: [] };
      },
      release: () => {},
    };
    const mockPool = { connect: async () => mockClient, query: mockClient.query } as any;

    const adapter = new PostgresPublicationWorkerDbAdapter(mockPool);
    const first = await adapter.reserveNonce(SIGNER, 84532n, 7, 'intent-1');
    const second = await adapter.reserveNonce(SIGNER, 84532n, 7, 'intent-2');

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(executedSql.some((s) => s.includes('pg_advisory_xact_lock'))).toBe(true);
  });

  it('markSnapshotReorgDetected throws INVALID_TRANSITION when snapshot is FINALIZED (SEC-08)', async () => {
    const mockClient = {
      query: async (sql: string) => {
        if (sql.includes('SELECT status FROM bounty_merkle_snapshots')) {
          return { rows: [{ status: 'FINALIZED' }] };
        }
        return { rows: [] };
      },
      release: () => {},
    };
    const mockPool = { connect: async () => mockClient, query: mockClient.query } as any;

    const adapter = new PostgresPublicationWorkerDbAdapter(mockPool);
    await expect(
      adapter.markSnapshotReorgDetected('snap-1', 'pre-pub reorg')
    ).rejects.toThrow('INVALID_TRANSITION');
  });

  it('PublishedSnapshotReorgSweeper marks PUBLISHED snapshot as REORG_DETECTED on root divergence and treats RPC errors as inconclusive', async () => {
    const reorgCalls: Array<{ id: string; reason: string }> = [];
    const iface = new ethers.Interface(['function bountyMerkleRoots(address) view returns (bytes32)']);

    const sweeper = new PublishedSnapshotReorgSweeper(
      {
        listActivePublishedSnapshots: async () => [
          {
            id: 'snap-ok',
            token_address: TOKEN,
            contract_address: CONTRACT,
            network_id: 'base-sepolia',
            chain_id: 84532n,
            merkle_root: ROOT_A,
            confirmed_block_number: 100n,
          },
          {
            id: 'snap-reorg',
            token_address: TOKEN,
            contract_address: CONTRACT,
            network_id: 'base-mainnet',
            chain_id: 8453n,
            merkle_root: ROOT_A,
            confirmed_block_number: 200n,
          },
          {
            id: 'snap-rpc-err',
            token_address: TOKEN,
            contract_address: CONTRACT,
            network_id: 'robinhood-mainnet',
            chain_id: 4663n,
            merkle_root: ROOT_A,
            confirmed_block_number: 300n,
          },
        ],
        markSnapshotReorgDetected: async (id, reason) => {
          reorgCalls.push({ id, reason });
        },
      },
      async (networkId) => {
        if (networkId === 'base-sepolia') {
          return {
            getNetwork: async () => ({ chainId: 84532n }),
            call: async () => iface.encodeFunctionResult('bountyMerkleRoots', [ROOT_A]),
          };
        }
        if (networkId === 'base-mainnet') {
          return {
            getNetwork: async () => ({ chainId: 8453n }),
            call: async () => iface.encodeFunctionResult('bountyMerkleRoots', [ROOT_B]),
          };
        }
        throw new Error('RPC_TIMEOUT');
      }
    );

    const report = await sweeper.sweepOnce();
    expect(report.checked).toBe(3);
    expect(report.consistent).toBe(1);
    expect(report.reorgDetected).toEqual(['snap-reorg']);
    expect(report.inconclusive).toHaveLength(1);
    expect(report.inconclusive[0].snapshotId).toBe('snap-rpc-err');
    expect(reorgCalls).toHaveLength(1);
    expect(reorgCalls[0].id).toBe('snap-reorg');
  });
});
