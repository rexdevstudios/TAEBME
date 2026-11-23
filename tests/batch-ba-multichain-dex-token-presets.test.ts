import { describe, expect, it } from 'bun:test';
import { ethers } from 'ethers';
import {
  EVM_DEX_CHAINS,
  EVM_DEX_TOKEN_PRESETS,
  getDefaultDexTokenForChain,
  getDexTokenPresetsForChain,
} from '../packages/launchpad/web3-provider';

describe('Phase BA: Authoritative 6-Chain Blue-Chip DEX Token Preset Registry', () => {
  it('[BA1.1] Every supported EVM DEX chain has >= 3 verified checksummed token presets', () => {
    const chainIds = Object.keys(EVM_DEX_CHAINS).map(Number);
    expect(chainIds.sort((a, b) => a - b)).toEqual([1, 10, 56, 137, 8453, 42161]);

    for (const cid of chainIds) {
      const presets = getDexTokenPresetsForChain(cid);
      expect(presets.length).toBeGreaterThanOrEqual(3);
      for (const p of presets) {
        expect(p.chainId).toBe(cid);
        expect(ethers.isAddress(p.address)).toBe(true);
        // Must match exact EIP-55 checksum
        expect(ethers.getAddress(p.address)).toBe(p.address);
      }
    }
  });

  it('[BA1.2] getDefaultDexTokenForChain returns chain-specific canonical token and safely falls back to Base on unknown chainId', () => {
    expect(getDefaultDexTokenForChain(8453).address).toBe(
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
    );
    expect(getDefaultDexTokenForChain(42161).address).toBe(
      '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
    );
    expect(getDefaultDexTokenForChain(56).address).toBe(
      '0x55d398326f99059fF775485246999027B3197955'
    );
    expect(getDefaultDexTokenForChain(999999).chainId).toBe(8453);
    expect(Object.keys(EVM_DEX_TOKEN_PRESETS).length).toBe(6);
  });
});
