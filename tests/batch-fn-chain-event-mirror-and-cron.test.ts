import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { encodeEventTopics, encodeAbiParameters, parseAbiParameters } from 'viem';
import {
  LAUNCHPAD_EVENT_ABIS,
  applyMirroredEventsToPostgres,
  computeDeterministicChainEventId,
  computeIncrementalBlockWindow,
  decodeLaunchpadEventLog,
} from '../packages/launchpad/chain-event-mirror';

const ROOT = path.resolve(import.meta.dir, '..');

describe('Phase FN: Incremental On-Chain Event Mirror (eth_getLogs Cursor -> chain_events -> token_launches)', () => {
  test('computeDeterministicChainEventId produces stable RFC-4122 UUIDs for atomic ON CONFLICT idempotency', () => {
    const tx = '0x' + 'ab'.repeat(32);
    const id1 = computeDeterministicChainEventId('base-mainnet', tx, 4);
    const id2 = computeDeterministicChainEventId('BASE-MAINNET', tx.toUpperCase(), 4);
    const idDiff = computeDeterministicChainEventId('base-mainnet', tx, 5);

    expect(id1).toBe(id2);
    expect(id1).not.toBe(idDiff);
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('computeIncrementalBlockWindow enforces finality lag and maxBlockSpan clamping', () => {
    // Cold start
    const cold = computeIncrementalBlockWindow({
      lastIndexedBlock: null,
      latestBlock: 10000n,
      maxBlockSpan: 2000n,
      finalityLag: 1n,
    });
    expect(cold).not.toBeNull();
    expect(cold!.fromBlock).toBe(8000n);
    expect(cold!.toBlock).toBe(9999n);

    // Caught up
    const caughtUp = computeIncrementalBlockWindow({
      lastIndexedBlock: 9999n,
      latestBlock: 10000n,
      maxBlockSpan: 2000n,
      finalityLag: 1n,
    });
    expect(caughtUp).toBeNull();

    // Clamped span when behind by 10,000 blocks
    const behind = computeIncrementalBlockWindow({
      lastIndexedBlock: 1000n,
      latestBlock: 11000n,
      maxBlockSpan: 2000n,
      finalityLag: 1n,
    });
    expect(behind!.fromBlock).toBe(1001n);
    expect(behind!.toBlock).toBe(3000n);
  });

  test('decodeLaunchpadEventLog & applyMirroredEventsToPostgres decode TokenPurchased/TokenGraduated and update monotonically', async () => {
    const tokenAddr = '0x1111111111111111111111111111111111111111';
    const buyerAddr = '0x2222222222222222222222222222222222222222';
    const txHash = ('0x' + 'cd'.repeat(32)) as `0x${string}`;

    const purchasedTopics = encodeEventTopics({
      abi: LAUNCHPAD_EVENT_ABIS,
      eventName: 'TokenPurchased',
      args: { tokenAddress: tokenAddr, buyer: buyerAddr },
    });
    const purchasedData = encodeAbiParameters(
      parseAbiParameters('uint256, uint256, uint256'),
      [100000000000000000000n, 500000000000000000n, 2500000000000000000n]
    );

    const decodedPurchase = decodeLaunchpadEventLog({
      address: '0x3333333333333333333333333333333333333333',
      topics: purchasedTopics as `0x${string}`[],
      data: purchasedData,
      blockNumber: 5500n,
      transactionHash: txHash,
      logIndex: 2,
    });
    expect(decodedPurchase?.eventName).toBe('TokenPurchased');
    expect(decodedPurchase?.tokenAddress.toLowerCase()).toBe(tokenAddr);
    expect(decodedPurchase?.newTotalRaisedWei).toBe('2500000000000000000');

    const queries: string[] = [];
    const mockPool = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rowCount: 1, rows: [] };
      },
    };
    const res = await applyMirroredEventsToPostgres(mockPool, 'base-mainnet', [decodedPurchase!]);
    expect(res.eventsInserted).toBe(1);
    expect(res.launchesUpdated).toBe(1);
    expect(queries.some((q) => q.includes('INSERT INTO chain_events') && q.includes('ON CONFLICT (id) DO NOTHING'))).toBe(true);
    expect(queries.some((q) => q.includes('UPDATE token_launches') && q.includes('GREATEST'))).toBe(true);
  });

  test('wires fail-closed /api/cron/chain-events-sync with isCronAuthorized & Phase FM Multi-RPC getEvmPublicClient', () => {
    const cronSrc = fs.readFileSync(path.join(ROOT, 'app/api/cron/chain-events-sync/route.ts'), 'utf8');
    expect(cronSrc).toContain('isCronAuthorized(req)');
    expect(cronSrc).toContain('getEvmPublicClient');
    expect(cronSrc).toContain('computeIncrementalBlockWindow');
    expect(cronSrc).toContain('applyMirroredEventsToPostgres');
  });
});
