import { describe, it, expect } from 'vitest';
import {
  encodeDexSettlementIdempotencyKey,
  serializeTradeIntentsToCsv,
  summarizeAndFilterTradeIntents,
} from '../packages/launchpad/web3-provider';

describe('Phase BJ — Multi-Chain History Filter & Formula-Safe CSV Audit Export', () => {
  it('[BJ1.1] summarizeAndFilterTradeIntents filters by specific EVM chainId while preserving full summary counts', () => {
    const baseTx = '0x' + 'a'.repeat(64);
    const arbTx = '0x' + 'b'.repeat(64);
    const items = [
      {
        id: 'base-1',
        status: 'EXECUTED',
        idempotencyKey: encodeDexSettlementIdempotencyKey({ chainId: 8453, txHash: baseTx, intentId: 'base-1' }),
      },
      {
        id: 'arb-1',
        status: 'EXECUTED',
        idempotencyKey: encodeDexSettlementIdempotencyKey({ chainId: 42161, txHash: arbTx, intentId: 'arb-1' }),
      },
      {
        id: 'paper-1',
        status: 'APPROVED',
        idempotencyKey: 'paper-order-1',
      },
    ];

    const arbOnly = summarizeAndFilterTradeIntents(items, 'DEX_SETTLED', 42161);
    expect(arbOnly.counts.dexSettled).toBe(2);
    expect(arbOnly.filtered.map((i) => i.id)).toEqual(['arb-1']);

    const baseOnly = summarizeAndFilterTradeIntents(items, 'ALL', 8453);
    expect(baseOnly.filtered.map((i) => i.id)).toEqual(['base-1']);
  });

  it('[BJ2.1] serializeTradeIntentsToCsv outputs RFC-4180 CSV with chain explorer metadata and formula-injection guard', () => {
    const arbTx = '0x' + 'c'.repeat(64);
    const csv = serializeTradeIntentsToCsv([
      {
        id: 'intent-1',
        createdAt: '2026-11-23T09:00:00.000Z',
        stage: 'LIVE',
        side: 'BUY',
        symbol: '=CMD("evil"),USDC/WETH',
        quantity: 0.05,
        status: 'EXECUTED',
        idempotencyKey: encodeDexSettlementIdempotencyKey({ chainId: 42161, txHash: arbTx, intentId: 'intent-1' }),
      },
    ]);

    const lines = csv.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('id,createdAt,stage,side,symbol,quantity,status,chainId,txHash,explorerUrl');
    // Formula prefix must be neutralized with leading single quote and RFC-4180 double-quoted
    expect(lines[1]).toContain('"\'=CMD(""evil""),USDC/WETH"');
    expect(lines[1]).toContain(`,42161,${arbTx},https://arbiscan.io/tx/${arbTx}`);
  });
});
