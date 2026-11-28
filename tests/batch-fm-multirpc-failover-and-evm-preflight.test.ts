import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  decodeEvmRevertReason,
  getEvmPublicClient,
  resolveEvmRpcUrls,
  simulateEvmTransactionPreflight,
  verifyEvmNativePayment,
} from '../packages/launchpad/evm-verifier';

const ROOT = path.resolve(import.meta.dir, '..');

describe('Phase FM: Multi-RPC Failover, Confirmation Depth Guard & Stateless Pre-Flight EVM Simulation', () => {
  test('resolveEvmRpcUrls provides multi-RPC fallback lists for Base, Base Sepolia & Arbitrum and preserves null for unsupported chains', () => {
    const baseUrls = resolveEvmRpcUrls('base-mainnet');
    expect(baseUrls.length).toBeGreaterThanOrEqual(2);
    expect(baseUrls).toContain('https://mainnet.base.org');

    const arbUrls = resolveEvmRpcUrls('arbitrum-mainnet');
    expect(arbUrls.length).toBeGreaterThanOrEqual(2);

    const ethUrls = resolveEvmRpcUrls('1');
    expect(ethUrls.length).toBeGreaterThanOrEqual(2);

    expect(getEvmPublicClient('base-mainnet')).not.toBeNull();
    expect(getEvmPublicClient('unsupported-chain-xyz')).toBeNull();
  });

  test('verifyEvmNativePayment enforces minConfirmations depth guard when getBlockNumber is available', async () => {
    const txHash = '0x' + 'a'.repeat(64);
    const sender = '0x1111111111111111111111111111111111111111';
    const treasury = '0x2222222222222222222222222222222222222222';

    const mockClient = {
      getTransactionReceipt: async () => ({ status: 'success', blockNumber: 100n }),
      getTransaction: async () => ({ from: sender, to: treasury, value: 5000000000000000n }),
      getBlockNumber: async () => 100n, // only 1 confirmation
    } as any;

    const pendingRes = await verifyEvmNativePayment({
      txHash,
      expectedFrom: sender,
      expectedTo: treasury,
      minValueWei: 5000000000000000n,
      minConfirmations: 2,
      customClient: mockClient,
    });
    expect(pendingRes.status).toBe('pending');
    expect(pendingRes.confirmations).toBe(1);

    const confirmedRes = await verifyEvmNativePayment({
      txHash,
      expectedFrom: sender,
      expectedTo: treasury,
      minValueWei: 5000000000000000n,
      minConfirmations: 1,
      customClient: mockClient,
    });
    expect(confirmedRes.status).toBe('confirmed');
    expect(confirmedRes.confirmations).toBe(1);
  });

  test('simulateEvmTransactionPreflight returns WILL_SUCCEED with estimatedGas and decodes LIKELY_REVERT cleanly', async () => {
    const ok = await simulateEvmTransactionPreflight({
      chainId: 8453,
      from: '0x1111111111111111111111111111111111111111',
      to: '0x2222222222222222222222222222222222222222',
      data: '0x1234',
      value: '1000000000000000',
      customEstimateGas: async () => 185000n,
    });
    expect(ok.status).toBe('WILL_SUCCEED');
    expect(ok.estimatedGas).toBe('185000');

    const reverted = await simulateEvmTransactionPreflight({
      chainId: 8453,
      from: '0x1111111111111111111111111111111111111111',
      to: '0x2222222222222222222222222222222222222222',
      data: '0x1234',
      customEstimateGas: async () => {
        throw new Error('execution reverted: ERC20: transfer amount exceeds allowance');
      },
    });
    expect(reverted.status).toBe('LIKELY_REVERT');
    expect(reverted.revertReason).toContain('ALLOWANCE_REQUIRED');

    expect(decodeEvmRevertReason('insufficient funds for gas * price + value')).toContain('INSUFFICIENT_FUNDS');
  });

  test('wires preflightSimulation in /api/trading/execute and renders Pre-Flight EVM badge in /trading', () => {
    const execSrc = fs.readFileSync(path.join(ROOT, 'app/api/trading/execute/route.ts'), 'utf8');
    const tradingSrc = fs.readFileSync(path.join(ROOT, 'app/trading/page.tsx'), 'utf8');

    expect(execSrc).toContain('simulateEvmTransactionPreflight');
    expect(execSrc).toContain('preflightSimulation');
    expect(tradingSrc).toContain('PRE-FLIGHT EVM:');
    expect(tradingSrc).toContain('dexPreflight');
  });
});
