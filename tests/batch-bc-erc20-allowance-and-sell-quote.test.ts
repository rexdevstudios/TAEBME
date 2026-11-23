import { describe, expect, it } from 'bun:test';
import {
  ZEROX_ALLOWANCE_HOLDER_ADDRESS,
  ZEROX_NATIVE_ETH,
  buildErc20ApproveTransaction,
  fetchZeroXSwapQuote,
} from '../packages/trading/zerox-swap-client';

describe('Phase BC: ERC-20 Allowance Target Inspector & 1-Click approve() Calldata Builder', () => {
  it('[BC1.1] buildErc20ApproveTransaction encodes valid ERC-20 approve(address,uint256) calldata (selector 0x095ea7b3) and rejects invalid inputs', () => {
    const baseUsdc = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    const tx = buildErc20ApproveTransaction({
      tokenAddress: baseUsdc,
      spender: ZEROX_ALLOWANCE_HOLDER_ADDRESS,
      amountWei: '25000000',
    });

    expect(tx.to).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(tx.spender).toBe(ZEROX_ALLOWANCE_HOLDER_ADDRESS);
    expect(tx.value).toBe('0');
    expect(tx.data.startsWith('0x095ea7b3')).toBe(true);
    expect(tx.data.length).toBe(138); // 4-byte selector + two 32-byte words

    expect(() =>
      buildErc20ApproveTransaction({
        tokenAddress: 'not-an-address',
        amountWei: '100',
      })
    ).toThrow('INVALID_ERC20_TOKEN_ADDRESS');

    expect(() =>
      buildErc20ApproveTransaction({
        tokenAddress: baseUsdc,
        amountWei: '0',
      })
    ).toThrow('INVALID_ERC20_APPROVE_AMOUNT');
  });

  it('[BC1.2] fetchZeroXSwapQuote always populates allowanceTarget & sellToken on SELL orders and sets allowanceTarget=null on BUY orders', async () => {
    const baseUsdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    const taker = '0x4444444444444444444444444444444444444444';
    const partnerFee = {
      enabled: true,
      feeBps: 25,
      feePct: 0.25,
      feeRecipient: '0x03516768f27433757c91C89E1C71722646E21208',
      chainId: 8453,
      disclosure: '0.25% protocol fee',
    };

    // Mock 0x response for SELL before allowance is granted
    const sellQuote = await fetchZeroXSwapQuote({
      chainId: 8453,
      side: 'SELL',
      tokenAddress: baseUsdc,
      sellAmountWei: '10000000',
      takerAddress: taker,
      slippageBps: 100,
      partnerFee,
      apiKeyOverride: 'live_test_key',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            sellAmount: '10000000',
            buyAmount: '3000000000000000',
            issues: { allowance: { spender: ZEROX_ALLOWANCE_HOLDER_ADDRESS } },
            transaction: {
              to: ZEROX_ALLOWANCE_HOLDER_ADDRESS,
              data: '0x1234',
              value: '0',
            },
          }),
          { status: 200 }
        ),
    });

    expect(sellQuote.available).toBe(true);
    expect(sellQuote.sellToken).toBe(baseUsdc);
    expect(sellQuote.buyToken).toBe(ZEROX_NATIVE_ETH);
    expect(sellQuote.allowanceTarget).toBe(ZEROX_ALLOWANCE_HOLDER_ADDRESS);

    // BUY order selling native ETH must have allowanceTarget === null
    const buyQuote = await fetchZeroXSwapQuote({
      chainId: 8453,
      side: 'BUY',
      tokenAddress: baseUsdc,
      sellAmountWei: '10000000000000000',
      takerAddress: taker,
      slippageBps: 100,
      partnerFee,
      apiKeyOverride: 'live_test_key',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            sellAmount: '10000000000000000',
            buyAmount: '30000000',
            transaction: {
              to: ZEROX_ALLOWANCE_HOLDER_ADDRESS,
              data: '0x5678',
              value: '10000000000000000',
            },
          }),
          { status: 200 }
        ),
    });

    expect(buyQuote.available).toBe(true);
    expect(buyQuote.allowanceTarget).toBeNull();
  });
});
