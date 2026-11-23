import { describe, it, expect } from 'vitest';
import {
  fetchAutoPilotSpotPrices,
  hydrateOpenPositionsWithLivePrices,
  syncActiveAutoPilotRegistry,
  updateActiveAutoPilotWalletList,
} from '../packages/agent/autopilot-market-feed';
import { evaluateAutoPilotPositionExit } from '../packages/agent/autopilot-policy';

describe('Phase BN — Multi-Tenant Auto-Pilot Registry & Live Spot Price Feed Adapter', () => {
  it('[BN1.1] updateActiveAutoPilotWalletList deduplicates, normalizes casing, and removes disabled wallets', () => {
    const w1 = '0xAAA0000000000000000000000000000000000001';
    const w2 = '0xBBB0000000000000000000000000000000000002';

    const list1 = updateActiveAutoPilotWalletList([], w1, true);
    expect(list1).toEqual([w1.toLowerCase()]);

    const list2 = updateActiveAutoPilotWalletList(list1, w2, true);
    expect(list2).toEqual([w2.toLowerCase(), w1.toLowerCase()]);

    // Re-enabling existing wallet deduplicates cleanly
    const list3 = updateActiveAutoPilotWalletList(list2, w1.toLowerCase(), true);
    expect(list3).toEqual([w1.toLowerCase(), w2.toLowerCase()]);

    // Disabling removes wallet cleanly
    const list4 = updateActiveAutoPilotWalletList(list3, w1, false);
    expect(list4).toEqual([w2.toLowerCase()]);
  });

  it('[BN1.2] syncActiveAutoPilotRegistry updates active list without throwing in offline mode', async () => {
    const w = '0xccc0000000000000000000000000000000000003';
    const afterAdd = await syncActiveAutoPilotRegistry(w, true);
    expect(afterAdd).toContain(w);
    const afterRemove = await syncActiveAutoPilotRegistry(w, false);
    expect(afterRemove).not.toContain(w);
  });

  it('[BN2.1] fetchAutoPilotSpotPrices + hydrateOpenPositionsWithLivePrices feed accurate TP/SL evaluation', async () => {
    const mockFetch: typeof fetch = (async (input: any) => {
      const url = String(input);
      if (url.includes('symbol=BTCUSDT')) {
        return new Response(JSON.stringify({ symbol: 'BTCUSDT', price: '115000.50' }), { status: 200 });
      }
      if (url.includes('symbol=ETHUSDT')) {
        return new Response(JSON.stringify({ symbol: 'ETHUSDT', price: '2800.00' }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    const prices = await fetchAutoPilotSpotPrices(['btcusdt', 'ETHUSDT', 'BADSYM'], mockFetch);
    expect(prices.BTCUSDT).toBe(115000.5);
    expect(prices.ETHUSDT).toBe(2800);
    expect(prices.BADSYM).toBeUndefined();

    const hydrated = hydrateOpenPositionsWithLivePrices(
      [
        { symbol: 'BTCUSDT', entryPrice: 100000, currentPrice: 100000, quantity: 0.01 },
        { symbol: 'ETHUSDT', entryPrice: 3000, currentPrice: 3000, quantity: 0.5 },
      ],
      prices
    );

    const btcExit = evaluateAutoPilotPositionExit({
      entryPrice: hydrated[0].entryPrice,
      currentPrice: hydrated[0].currentPrice,
      takeProfitPct: 12,
      stopLossPct: 5,
    });
    const ethExit = evaluateAutoPilotPositionExit({
      entryPrice: hydrated[1].entryPrice,
      currentPrice: hydrated[1].currentPrice,
      takeProfitPct: 12,
      stopLossPct: 5,
    });

    expect(btcExit.action).toBe('TAKE_PROFIT_SELL');
    expect(ethExit.action).toBe('STOP_LOSS_SELL');
  });
});
