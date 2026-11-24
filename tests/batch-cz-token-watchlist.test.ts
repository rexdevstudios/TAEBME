/**
 * tests/batch-cz-token-watchlist.test.ts
 *
 * Phase CZ Verification Suite:
 *  - Deterministic pin/unpin toggle, deduplication, and 12-item cap
 *  - Defensive localStorage JSON parser rejecting malformed/corrupt rows
 *  - Canonical /trading handoff URL builder for both EVM contract tokens and CEX symbols
 */

import { describe, expect, test } from 'bun:test';
import {
  MAX_WATCHLIST_ITEMS,
  buildWatchlistTradeHref,
  isWatchlistPinned,
  parseWatchlistStorage,
  toggleWatchlistItem,
  type WatchlistTokenItem,
} from '../packages/shared/token-watchlist';

describe('Phase CZ: Pin / Favorite Token Watchlist Engine', () => {
  test('[CZ1.1] toggleWatchlistItem pins at top and unpins cleanly on second toggle', () => {
    const first = toggleWatchlistItem([], {
      symbol: 'usdc',
      name: 'USD Coin',
      chainId: 8453,
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    });
    expect(first.length).toBe(1);
    expect(first[0].symbol).toBe('USDC');
    expect(isWatchlistPinned(first, 8453, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBe(true);

    const removed = toggleWatchlistItem(first, {
      symbol: 'USDC',
      name: 'USD Coin',
      chainId: 8453,
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    });
    expect(removed.length).toBe(0);
    expect(isWatchlistPinned(removed, 8453, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBe(false);
  });

  test('[CZ1.2] enforces MAX_WATCHLIST_ITEMS cap and defensive storage parsing', () => {
    let list: WatchlistTokenItem[] = [];
    for (let i = 0; i < MAX_WATCHLIST_ITEMS + 5; i++) {
      list = toggleWatchlistItem(list, {
        symbol: `TOK${i}`,
        name: `Token ${i}`,
        chainId: 8453,
      });
    }
    expect(list.length).toBe(MAX_WATCHLIST_ITEMS);
    expect(parseWatchlistStorage('{broken-json')).toEqual([]);
    const parsed = parseWatchlistStorage(
      JSON.stringify([
        { symbol: 'eth', name: 'Ether', chainId: 8453 },
        { symbol: 'ETH', name: 'Duplicate', chainId: 8453 },
        { symbol: '', chainId: -1 },
      ])
    );
    expect(parsed.length).toBe(1);
    expect(parsed[0].symbol).toBe('ETH');
  });

  test('[CZ1.3] buildWatchlistTradeHref generates clean /trading handoff URLs', () => {
    const dexHref = buildWatchlistTradeHref({
      id: '8453:0xabc',
      symbol: 'USDC',
      name: 'USD Coin',
      chainId: 8453,
      address: '0xabc',
      pinnedAt: '2026-11-24T00:00:00.000Z',
    });
    expect(dexHref).toBe('/trading?token=0xabc&chainId=8453');

    const cexHref = buildWatchlistTradeHref({
      id: '8453:btcusdt',
      symbol: 'BTCUSDT',
      name: 'BTCUSDT',
      chainId: 8453,
      pinnedAt: '2026-11-24T00:00:00.000Z',
    });
    expect(cexHref).toBe('/trading?symbol=BTCUSDT');
  });
});
