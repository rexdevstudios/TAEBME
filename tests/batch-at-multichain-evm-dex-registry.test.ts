/**
 * tests/batch-at-multichain-evm-dex-registry.test.ts
 *
 * Phase AT Unit Tests:
 * 1. Verifies 100% parity between `EVM_DEX_CHAINS` and `ZEROX_SUPPORTED_CHAIN_IDS` (6 EVM chains).
 * 2. Verifies `getEvmExplorerTxUrl` generates accurate block explorer URLs for all 6 chains.
 * 3. Verifies `buildZeroXQuoteUrl` embeds `swapFeeBps` & `swapFeeRecipient` on Arbitrum (42161) & BSC (56).
 */

import { describe, it, expect } from 'bun:test';
import { EVM_DEX_CHAINS, getEvmExplorerTxUrl } from '../packages/launchpad/web3-provider';
import {
  ZEROX_NATIVE_ETH,
  ZEROX_SUPPORTED_CHAIN_IDS,
  buildZeroXQuoteUrl,
} from '../packages/trading/zerox-swap-client';

describe('Phase AT — Full 6-Chain EVM DEX Registry & Explorer Parity', () => {
  it('maintains 100% chainId parity between EVM_DEX_CHAINS and ZEROX_SUPPORTED_CHAIN_IDS', () => {
    const uiChainIds = Object.keys(EVM_DEX_CHAINS).map(Number).sort((a, b) => a - b);
    const zeroXChainIds = Array.from(ZEROX_SUPPORTED_CHAIN_IDS).sort((a, b) => a - b);
    expect(uiChainIds).toEqual(zeroXChainIds);
    expect(uiChainIds).toEqual([1, 10, 56, 137, 8453, 42161]);
  });

  it('maps transaction hashes to the right block explorer across all 6 EVM chains', () => {
    const tx = '0xabc123';
    expect(getEvmExplorerTxUrl(8453, tx)).toBe('https://basescan.org/tx/0xabc123');
    expect(getEvmExplorerTxUrl(42161, tx)).toBe('https://arbiscan.io/tx/0xabc123');
    expect(getEvmExplorerTxUrl(1, tx)).toBe('https://etherscan.io/tx/0xabc123');
    expect(getEvmExplorerTxUrl(10, tx)).toBe('https://optimistic.etherscan.io/tx/0xabc123');
    expect(getEvmExplorerTxUrl(137, tx)).toBe('https://polygonscan.com/tx/0xabc123');
    expect(getEvmExplorerTxUrl(56, tx)).toBe('https://bscscan.com/tx/0xabc123');
  });

  it('builds 0x v2 swap quote URLs with partner fee on Arbitrum (42161) and BSC (56)', () => {
    const treasury = '0x0c9f4a82b5ae258e8e65ca40ac4f1abc455c34b6';
    const taker = '0x4444444444444444444444444444444444444444';
    const arbUsdc = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
    const bscUsdt = '0x55d398326f99059fF775485246999027B3197955';

    const arbUrl = new URL(
      buildZeroXQuoteUrl({
        chainId: 42161,
        sellToken: ZEROX_NATIVE_ETH,
        buyToken: arbUsdc,
        sellAmount: '10000000000000000',
        taker,
        slippageBps: 100,
        feeBps: 25,
        feeRecipient: treasury,
      })
    );
    expect(arbUrl.searchParams.get('chainId')).toBe('42161');
    expect(arbUrl.searchParams.get('swapFeeRecipient')).toBe(treasury);

    const bscUrl = new URL(
      buildZeroXQuoteUrl({
        chainId: 56,
        sellToken: ZEROX_NATIVE_ETH,
        buyToken: bscUsdt,
        sellAmount: '10000000000000000',
        taker,
        slippageBps: 100,
        feeBps: 25,
        feeRecipient: treasury,
      })
    );
    expect(bscUrl.searchParams.get('chainId')).toBe('56');
    expect(bscUrl.searchParams.get('swapFeeBps')).toBe('25');
  });
});
