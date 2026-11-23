import { describe, expect, it } from 'bun:test';
import {
  encodeDexSettlementIdempotencyKey,
  parseDexSettlementFromIdempotencyKey,
} from '../packages/launchpad/web3-provider';
import {
  confirmUserDexTradeIntentSettlement,
  defaultBinanceExecutionDbAdapter,
} from '../packages/shared/db-pool';

describe('Phase BF: On-Chain DEX Settlement Confirmation & Explorer Link Parser', () => {
  it('[BF1.1] encodeDexSettlementIdempotencyKey & parseDexSettlementFromIdempotencyKey round-trip across 6 EVM chains and reject invalid txHash', () => {
    const validHash = `0x${'a1b2c3d4'.repeat(8)}`;
    const encoded = encodeDexSettlementIdempotencyKey({
      chainId: 42161,
      txHash: validHash.toUpperCase(),
      intentId: '550e8400-e29b-41d4-a716-446655440000',
    });

    expect(encoded.startsWith('dex:42161:')).toBe(true);
    const parsed = parseDexSettlementFromIdempotencyKey(encoded);
    expect(parsed?.chainId).toBe(42161);
    expect(parsed?.txHash).toBe(validHash);
    expect(parsed?.explorerUrl).toBe(`https://arbiscan.io/tx/${validHash}`);

    expect(parseDexSettlementFromIdempotencyKey('exec-12345')).toBeNull();
    expect(parseDexSettlementFromIdempotencyKey(null)).toBeNull();

    expect(() =>
      encodeDexSettlementIdempotencyKey({
        chainId: 8453,
        txHash: '0x1234',
        intentId: 'id-1',
      })
    ).toThrow('INVALID_DEX_SETTLEMENT_TX_HASH');

    expect(() =>
      encodeDexSettlementIdempotencyKey({
        chainId: 999999,
        txHash: validHash,
        intentId: 'id-1',
      })
    ).toThrow('UNSUPPORTED_DEX_SETTLEMENT_CHAIN');
  });

  it('[BF1.2] confirmUserDexTradeIntentSettlement enforces strict user isolation in memory fallback when DB pool is offline', async () => {
    const prevDbUrl = process.env.DATABASE_URL_TESTNET;
    delete process.env.DATABASE_URL_TESTNET;
    try {
      const intentId = `bf-test-intent-${Date.now()}`;
      defaultBinanceExecutionDbAdapter.seedIntent({
        id: intentId,
        userId: 'user-owner-bf',
        stage: 'PAPER',
        symbol: 'USDC',
        side: 'BUY',
        type: 'MARKET',
        quantity: 0.05,
        maxSlippagePct: 1.0,
        idempotencyKey: `orig-${intentId}`,
        status: 'APPROVED',
      });

      const txHash = `0x${'f'.repeat(64)}`;

      // Other user cannot confirm owner's intent
      await expect(
        confirmUserDexTradeIntentSettlement({
          userIdentifier: 'user-attacker-bf',
          tradeIntentId: intentId,
          txHash,
          chainId: 8453,
        })
      ).rejects.toThrow('TRADE_INTENT_NOT_FOUND_OR_FORBIDDEN');

      // Owner confirms cleanly
      const confirmed = await confirmUserDexTradeIntentSettlement({
        userIdentifier: 'user-owner-bf',
        tradeIntentId: intentId,
        txHash,
        chainId: 8453,
      });
      expect(confirmed.status).toBe('EXECUTED');
      expect(parseDexSettlementFromIdempotencyKey(confirmed.idempotencyKey)?.explorerUrl).toBe(
        `https://basescan.org/tx/${txHash}`
      );
    } finally {
      if (prevDbUrl) process.env.DATABASE_URL_TESTNET = prevDbUrl;
    }
  });
});
