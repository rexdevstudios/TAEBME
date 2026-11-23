import { describe, it, expect } from 'vitest';
import {
  encodeDexSettlementIdempotencyKey,
  parseDexSettlementFromAuditReason,
  summarizeAndFilterTradeIntents,
} from '../packages/launchpad/web3-provider';

describe('Phase BH — Trade History Filter/Counters & Activity Feed Explorer Enrichment', () => {
  it('[BH1.1] summarizeAndFilterTradeIntents computes accurate counts and filters DEX_SETTLED, CEX_OR_PAPER, and REJECTED', () => {
    const arbTx = '0x' + 'a'.repeat(64);
    const items = [
      {
        id: '1',
        status: 'EXECUTED',
        idempotencyKey: encodeDexSettlementIdempotencyKey({ chainId: 42161, txHash: arbTx, intentId: '1' }),
      },
      {
        id: '2',
        status: 'APPROVED',
        idempotencyKey: 'paper-order-2',
      },
      {
        id: '3',
        status: 'REJECTED',
        idempotencyKey: 'risk-blocked-3',
      },
    ];

    const all = summarizeAndFilterTradeIntents(items, 'ALL');
    expect(all.counts).toEqual({
      total: 3,
      dexSettled: 1,
      cexOrPaper: 1,
      approved: 2,
      rejected: 1,
    });
    expect(all.filtered).toHaveLength(3);

    const dexOnly = summarizeAndFilterTradeIntents(items, 'DEX_SETTLED');
    expect(dexOnly.filtered.map((i) => i.id)).toEqual(['1']);

    const cexPaperOnly = summarizeAndFilterTradeIntents(items, 'CEX_OR_PAPER');
    expect(cexPaperOnly.filtered.map((i) => i.id)).toEqual(['2']);

    const rejOnly = summarizeAndFilterTradeIntents(items, 'REJECTED');
    expect(rejOnly.filtered.map((i) => i.id)).toEqual(['3']);
  });

  it('[BH2.1] parseDexSettlementFromAuditReason extracts chainId, txHash, and explorerUrl from DEX_SWAP_TX_CONFIRMED audit reason', () => {
    const txHash = '0x' + 'f'.repeat(64);
    const parsed = parseDexSettlementFromAuditReason(
      `On-chain 0x Swap v2 tx confirmed on chain 42161: ${txHash}`
    );
    expect(parsed).toEqual({
      chainId: 42161,
      txHash,
      explorerUrl: `https://arbiscan.io/tx/${txHash}`,
    });

    expect(parseDexSettlementFromAuditReason('Stage: PAPER, Symbol: BTCUSDT')).toBeNull();
    expect(parseDexSettlementFromAuditReason(`On-chain 0x Swap v2 tx confirmed on chain 999999: ${txHash}`)).toBeNull();
  });
});
