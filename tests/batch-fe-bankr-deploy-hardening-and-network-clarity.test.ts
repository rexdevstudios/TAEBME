import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  BANKR_BASE_QUOTE_TOKENS,
  buildBankrAuthHeaders,
  resolveBankrPairedTokenAddress,
} from '../packages/launchpad/bankr-client';
import { KNOWN_NAVBAR_CHAINS } from '../packages/trading/paper-wallet';

const ROOT = path.resolve(import.meta.dir, '..');

describe('Phase FE: Bankr Deploy Hardening, docs.bankr.bot Parity & Navbar Network Clarity', () => {
  test('buildBankrAuthHeaders sends X-Partner-Key for bk_ptr_ and X-API-Key for bk_usr_', () => {
    const ptr = buildBankrAuthHeaders('bk_ptr_abc123');
    expect(ptr['X-Partner-Key']).toBe('bk_ptr_abc123');
    expect(ptr['X-API-Key']).toBeUndefined();

    const usr = buildBankrAuthHeaders('bk_usr_xyz789');
    expect(usr['X-API-Key']).toBe('bk_usr_xyz789');
    expect(usr['X-Partner-Key']).toBeUndefined();
  });

  test('resolveBankrPairedTokenAddress whitelists all 5 official Base quote tokens & rejects non-Base or unknown', () => {
    expect(BANKR_BASE_QUOTE_TOKENS).toHaveLength(5);
    for (const qt of BANKR_BASE_QUOTE_TOKENS) {
      expect(resolveBankrPairedTokenAddress('base', qt.address.toUpperCase())).toBe(qt.address);
      expect(resolveBankrPairedTokenAddress('arbitrum', qt.address)).toBeUndefined();
    }
    expect(resolveBankrPairedTokenAddress('base', '0x0000000000000000000000000000000000000001')).toBeUndefined();
  });

  test('KNOWN_NAVBAR_CHAINS preserves >= 10 entries and cleanly categorizes deployer vs dex vs wallet_only', () => {
    expect(KNOWN_NAVBAR_CHAINS.length).toBeGreaterThanOrEqual(10);
    expect(KNOWN_NAVBAR_CHAINS.filter((c) => c.category === 'deployer')).toHaveLength(5);
    expect(KNOWN_NAVBAR_CHAINS.filter((c) => c.category === 'dex')).toHaveLength(4);
    const opBnb = KNOWN_NAVBAR_CHAINS.find((c) => c.chainId === 204);
    expect(opBnb?.category).toBe('wallet_only');
  });

  test('bankr-deploy/route.ts enforces 402 credit pre-check on live single deploy, free 0 cr simulation & pairedTokenAddress', () => {
    const src = fs.readFileSync(path.join(ROOT, 'app/api/launchpad/bankr-deploy/route.ts'), 'utf8');
    expect(src).toContain('resolveBankrPairedTokenAddress');
    expect(src).toContain('INSUFFICIENT_CREDITS: Required');
    expect(src).toContain('{ status: 402 }');
    expect(src).toContain('const shouldChargeCredits = !isSimulateOnly && result.status === \'deployed\' && launchCostCr > 0');
    expect(src).toContain('creditsBurned: shouldChargeCredits ? launchCostCr : 0');
  });

  test('HeaderNav.tsx groups chains with <optgroup> and /launchpad wires Base Quote Token selector', () => {
    const navSrc = fs.readFileSync(path.join(ROOT, 'app/components/HeaderNav.tsx'), 'utf8');
    const lpSrc = fs.readFileSync(path.join(ROOT, 'app/launchpad/page.tsx'), 'utf8');

    expect(navSrc).toContain('<optgroup');
    expect(navSrc).toContain('Launchpad & Deployer');
    expect(navSrc).toContain('DEX Swap Only (/trading)');
    expect(lpSrc).toContain('BANKR_BASE_QUOTE_TOKENS');
    expect(lpSrc).toContain('selectedBaseQuoteToken');
    expect(lpSrc).toContain('pairedTokenAddress: selectedBaseQuoteToken');
    expect(lpSrc).toContain("if (ch.id === 'solana' && count === 0) return null");
  });
});
