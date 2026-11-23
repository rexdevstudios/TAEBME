import { describe, expect, it } from 'bun:test';
import { resolveDexSellAmountAtomic } from '../packages/launchpad/web3-provider';

describe('Phase BD: Token Decimals-Aware sellAmount Conversion for 0x Swap v2', () => {
  it('[BD1.1] BUY orders always use 18 decimals (native coin ETH/POL/BNB) regardless of buyToken decimals', () => {
    const res = resolveDexSellAmountAtomic({
      side: 'BUY',
      quantity: 0.01,
      chainId: 8453,
      tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // 6-decimal Base USDC
    });
    expect(res.sellTokenDecimals).toBe(18);
    expect(res.sellAmountAtomic).toBe('10000000000000000');
  });

  it('[BD1.2] SELL orders resolve 6 decimals for Base/Arbitrum USDC & USDT, 8 decimals for cbBTC, and 18 decimals for BSC/standard ERC-20', () => {
    // Base USDC (6 decimals): 0.01 USDC = 10,000 atomic units
    const baseUsdcSell = resolveDexSellAmountAtomic({
      side: 'SELL',
      quantity: 0.01,
      chainId: 8453,
      tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    });
    expect(baseUsdcSell.sellTokenDecimals).toBe(6);
    expect(baseUsdcSell.sellAmountAtomic).toBe('10000');

    // Arbitrum USDC (6 decimals): 2.5 USDC = 2,500,000 atomic units
    const arbUsdcSell = resolveDexSellAmountAtomic({
      side: 'SELL',
      quantity: 2.5,
      chainId: 42161,
      tokenAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    });
    expect(arbUsdcSell.sellTokenDecimals).toBe(6);
    expect(arbUsdcSell.sellAmountAtomic).toBe('2500000');

    // Base cbBTC (8 decimals): 0.01 cbBTC = 1,000,000 satoshis
    const cbBtcSell = resolveDexSellAmountAtomic({
      side: 'SELL',
      quantity: 0.01,
      chainId: 8453,
      tokenAddress: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
    });
    expect(cbBtcSell.sellTokenDecimals).toBe(8);
    expect(cbBtcSell.sellAmountAtomic).toBe('1000000');

    // BSC USDT (18 decimals): 0.01 USDT = 10^16 atomic units
    const bscUsdtSell = resolveDexSellAmountAtomic({
      side: 'SELL',
      quantity: 0.01,
      chainId: 56,
      tokenAddress: '0x55d398326f99059fF775485246999027B3197955',
    });
    expect(bscUsdtSell.sellTokenDecimals).toBe(18);
    expect(bscUsdtSell.sellAmountAtomic).toBe('10000000000000000');
  });
});
