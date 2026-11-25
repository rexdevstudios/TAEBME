import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_PAPER_BALANCE_USD,
  KNOWN_NAVBAR_CHAINS,
  applyPaperTradeBalance,
  formatNativeWeiBalance,
  resolveChainDisplayMeta,
} from '../packages/trading/paper-wallet';

describe('Phase EK — Unified Multi-Chain Navbar Sync, Virtual Paper Balance & Clean Trading UX', () => {
  test('recognizes opBNB (204 / 0xcc), BNB Chain (56), Ethereum (1), Polygon (137), Optimism (10), Base, Arbitrum', () => {
    const opBnb = resolveChainDisplayMeta('0xcc');
    expect(opBnb.known).toBe(true);
    expect(opBnb.chainId).toBe(204);
    expect(opBnb.label).toBe('opBNB');
    expect(opBnb.nativeSymbol).toBe('BNB');

    expect(resolveChainDisplayMeta('0x2105').label).toBe('Base Mainnet');
    expect(resolveChainDisplayMeta('0x1').label).toBe('Ethereum');
    expect(resolveChainDisplayMeta('0x38').label).toBe('BNB Chain');
    expect(KNOWN_NAVBAR_CHAINS.length).toBeGreaterThanOrEqual(10);
  });

  test('applies virtual paper BUY/SELL balance updates and blocks insufficient BUY balance', () => {
    const buyOk = applyPaperTradeBalance({
      currentBalanceUsd: DEFAULT_PAPER_BALANCE_USD,
      side: 'BUY',
      notionalUsd: 1250.5,
    });
    expect(buyOk.ok).toBe(true);
    expect(buyOk.nextBalanceUsd).toBe(8749.5);

    const buyInsufficient = applyPaperTradeBalance({
      currentBalanceUsd: 500,
      side: 'BUY',
      notionalUsd: 750,
    });
    expect(buyInsufficient.ok).toBe(false);
    expect(buyInsufficient.reason).toContain('INSUFFICIENT_PAPER_BALANCE');

    const sellOk = applyPaperTradeBalance({
      currentBalanceUsd: 8749.5,
      side: 'SELL',
      notionalUsd: 500,
    });
    expect(sellOk.ok).toBe(true);
    expect(sellOk.nextBalanceUsd).toBe(9249.5);
  });

  test('formats native EVM hex wei balances accurately', () => {
    // 0.0425 ETH = 42500000000000000 wei = 0x96fe18ba504000
    expect(formatNativeWeiBalance('0x96fe18ba504000', 'ETH')).toBe('0.0425 ETH');
    expect(formatNativeWeiBalance('0xde0b6b3a7640000', 'BNB')).toBe('1.0000 BNB');
    expect(formatNativeWeiBalance(null, 'ETH')).toBe('0.0000 ETH');
  });

  test('verifies HeaderNav, web3-provider multi-chain switch, and Trading balance bar wiring', () => {
    const navSrc = fs.readFileSync(path.join(process.cwd(), 'app/components/HeaderNav.tsx'), 'utf8');
    const web3Src = fs.readFileSync(path.join(process.cwd(), 'packages/launchpad/web3-provider.ts'), 'utf8');
    const tradingSrc = fs.readFileSync(path.join(process.cwd(), 'app/trading/page.tsx'), 'utf8');

    expect(navSrc).toContain('KNOWN_NAVBAR_CHAINS');
    expect(web3Src).toContain('opBNB Mainnet');
    expect(web3Src).toContain('Object.values(EVM_DEX_CHAINS)');
    expect(tradingSrc).toContain('applyPaperTradeBalance');
    expect(tradingSrc).toContain('eth_getBalance');
    expect(tradingSrc).toContain('Trade Ticket (Buy / Sell)');
    expect(tradingSrc).toContain('NetworkMismatchBanner');
  });
});
