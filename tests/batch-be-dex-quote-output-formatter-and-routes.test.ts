import { describe, expect, it } from 'bun:test';
import { extractZeroXRouteSources } from '../packages/trading/zerox-swap-client';
import { formatDexQuoteOutputSummary } from '../packages/launchpad/web3-provider';

describe('Phase BE: 0x Swap v2 Human-Readable Output Formatter & Liquidity Route Extractor', () => {
  it('[BE1.1] extractZeroXRouteSources deduplicates DEX liquidity pool fills and falls back safely', () => {
    const sources = extractZeroXRouteSources({
      route: {
        fills: [
          { source: 'Uniswap_V4', proportionBps: '6000' },
          { source: 'Aerodrome', proportionBps: '4000' },
          { source: 'Uniswap_V4', proportionBps: '0' },
        ],
      },
    });
    expect(sources).toEqual(['Uniswap_V4', 'Aerodrome']);
    expect(extractZeroXRouteSources({})).toEqual(['0x_Settler_v2']);
    expect(extractZeroXRouteSources(null)).toEqual(['0x_Settler_v2']);
  });

  it('[BE1.2] formatDexQuoteOutputSummary formats 6-decimal USDC, 8-decimal cbBTC, and 18-decimal native ETH/BNB accurately', () => {
    // BUY Base USDC (6 decimals): 32,450,000 atomic = 32.45 USDC
    const buyUsdc = formatDexQuoteOutputSummary({
      side: 'BUY',
      chainId: 8453,
      tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      buyAmountAtomic: '32450000',
      minBuyAmountAtomic: '32125500',
    });
    expect(buyUsdc.buyTokenSymbol).toBe('USDC');
    expect(buyUsdc.buyTokenDecimals).toBe(6);
    expect(buyUsdc.estimatedOutFormatted).toBe('32.45');
    expect(buyUsdc.minOutFormatted).toBe('32.1255');

    // BUY Base cbBTC (8 decimals): 50,000 atomic = 0.0005 cbBTC
    const buyCbBtc = formatDexQuoteOutputSummary({
      side: 'BUY',
      chainId: 8453,
      tokenAddress: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
      buyAmountAtomic: '50000',
      minBuyAmountAtomic: '49500',
    });
    expect(buyCbBtc.buyTokenSymbol).toBe('cbBTC');
    expect(buyCbBtc.buyTokenDecimals).toBe(8);
    expect(buyCbBtc.estimatedOutFormatted).toBe('0.0005');

    // SELL on BSC (56) receives native BNB (18 decimals)
    const sellToBnb = formatDexQuoteOutputSummary({
      side: 'SELL',
      chainId: 56,
      tokenAddress: '0x55d398326f99059fF775485246999027B3197955',
      buyAmountAtomic: '25000000000000000',
      minBuyAmountAtomic: '24750000000000000',
    });
    expect(sellToBnb.buyTokenSymbol).toBe('BNB');
    expect(sellToBnb.buyTokenDecimals).toBe(18);
    expect(sellToBnb.estimatedOutFormatted).toBe('0.025');
  });
});
