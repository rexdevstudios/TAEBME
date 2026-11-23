import { describe, it, expect } from 'vitest';
import {
  buildTradeHistoryReTradeUrl,
  parseTradingHandoffSearchParams,
} from '../packages/agent/autonomous-terminal-engine';
import { encodeDexSettlementIdempotencyKey } from '../packages/launchpad/web3-provider';

describe('Phase BI — Trade History 1-Click Re-Trade Handoff URL Builder', () => {
  it('[BI1.1] buildTradeHistoryReTradeUrl routes settled DEX intents to DEX_NON_CUSTODIAL with preserved chainId', () => {
    const txHash = '0x' + 'b'.repeat(64);
    const idempotencyKey = encodeDexSettlementIdempotencyKey({
      chainId: 42161,
      txHash,
      intentId: 'intent_bi_arb_1',
    });

    const href = buildTradeHistoryReTradeUrl({
      symbol: 'USDC/WETH',
      side: 'SELL',
      quantity: 0.05,
      stage: 'LIVE',
      idempotencyKey,
    });

    expect(href.startsWith('/trading?')).toBe(true);
    const parsed = parseTradingHandoffSearchParams(href.slice('/trading?'.length));
    expect(parsed.symbol).toBe('USDC/WETH');
    expect(parsed.side).toBe('SELL');
    expect(parsed.qty).toBe(0.05);
    expect(parsed.mode).toBe('DEX_NON_CUSTODIAL');
    expect(parsed.rail).toBe('EXTERNAL_DEX_0X');
    expect(parsed.chainId).toBe(42161);
  });

  it('[BI1.2] buildTradeHistoryReTradeUrl routes non-DEX PAPER and LIVE CEX intents accurately', () => {
    const paperHref = buildTradeHistoryReTradeUrl({
      symbol: 'BTCUSDT',
      side: 'BUY',
      quantity: 0.01,
      stage: 'PAPER',
      idempotencyKey: 'paper-1',
    });
    const parsedPaper = parseTradingHandoffSearchParams(paperHref.slice('/trading?'.length));
    expect(parsedPaper.mode).toBe('PAPER');
    expect(parsedPaper.rail).toBe('EXTERNAL_CEX_AUTO');
    expect(parsedPaper.symbol).toBe('BTCUSDT');

    const cexHref = buildTradeHistoryReTradeUrl({
      symbol: 'ETHUSDT',
      side: 'SELL',
      quantity: 0.25,
      stage: 'LIVE',
      idempotencyKey: 'cex-live-2',
    });
    const parsedCex = parseTradingHandoffSearchParams(cexHref.slice('/trading?'.length));
    expect(parsedCex.mode).toBe('CEX_SINGLE_SHOT');
    expect(parsedCex.rail).toBe('EXTERNAL_CEX_AUTO');
    expect(parsedCex.side).toBe('SELL');
  });
});
