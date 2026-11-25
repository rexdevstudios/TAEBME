import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';
import {
  buildOwnedSubWalletChallenge,
  verifyOwnedSubWalletProof,
} from '../packages/agent/owned-wallet-proof';
import { validateOwnedWalletTransferPrompt } from '../packages/agent/copilot-engine';

describe('Phase EG — Multi-Owned Sub-Wallet Allowlist with Cryptographic Proof-of-Ownership', () => {
  const SECRET = 'unit-test-hmac-secret-phase-eg';

  test('verifies legitimate ECDSA signature from target sub-wallet', async () => {
    const primary = ethers.Wallet.createRandom();
    const subWallet = ethers.Wallet.createRandom();

    const ch = buildOwnedSubWalletChallenge({
      primaryWallet: primary.address,
      subWalletAddress: subWallet.address,
      secret: SECRET,
    });
    const sig = await subWallet.signMessage(ch.message);

    const res = verifyOwnedSubWalletProof({
      primaryWallet: primary.address,
      subWalletAddress: subWallet.address,
      signature: sig,
      challengeToken: ch.challengeToken,
      message: ch.message,
      secret: SECRET,
    });

    expect(res.valid).toBe(true);
    expect(res.normalizedSubWallet).toBe(subWallet.address.toLowerCase());
  });

  test('rejects forged signature signed by a different wallet (attacker)', async () => {
    const primary = ethers.Wallet.createRandom();
    const victimSub = ethers.Wallet.createRandom();
    const attacker = ethers.Wallet.createRandom();

    const ch = buildOwnedSubWalletChallenge({
      primaryWallet: primary.address,
      subWalletAddress: victimSub.address,
      secret: SECRET,
    });
    const forgedSig = await attacker.signMessage(ch.message);

    const res = verifyOwnedSubWalletProof({
      primaryWallet: primary.address,
      subWalletAddress: victimSub.address,
      signature: forgedSig,
      challengeToken: ch.challengeToken,
      message: ch.message,
      secret: SECRET,
    });

    expect(res.valid).toBe(false);
    expect(res.code).toBe('INVALID_SIGNATURE');
  });

  test('rejects expired or tampered challenge tokens and primary-wallet self-linking', async () => {
    const primary = ethers.Wallet.createRandom();
    const subWallet = ethers.Wallet.createRandom();

    expect(() =>
      buildOwnedSubWalletChallenge({
        primaryWallet: primary.address,
        subWalletAddress: primary.address,
        secret: SECRET,
      })
    ).toThrow('SAME_AS_PRIMARY');

    const ch = buildOwnedSubWalletChallenge({
      primaryWallet: primary.address,
      subWalletAddress: subWallet.address,
      secret: SECRET,
      ttlMs: 60_000,
    });
    const sig = await subWallet.signMessage(ch.message);

    const expired = verifyOwnedSubWalletProof({
      primaryWallet: primary.address,
      subWalletAddress: subWallet.address,
      signature: sig,
      challengeToken: ch.challengeToken,
      secret: SECRET,
      nowMs: Date.now() + 120_000,
    });
    expect(expired.valid).toBe(false);
    expect(expired.code).toBe('CHALLENGE_EXPIRED');

    const tampered = verifyOwnedSubWalletProof({
      primaryWallet: primary.address,
      subWalletAddress: subWallet.address,
      signature: sig,
      challengeToken: `${ch.challengeToken.slice(0, -4)}dead`,
      secret: SECRET,
    });
    expect(tampered.valid).toBe(false);
    expect(tampered.code).toBe('INVALID_CHALLENGE_TOKEN');
  });

  test('allows Copilot transfer to verified sub-wallet while blocking unlinked third-party address', () => {
    const primary = ethers.Wallet.createRandom().address.toLowerCase();
    const verifiedSub = ethers.Wallet.createRandom().address.toLowerCase();
    const stranger = ethers.Wallet.createRandom().address.toLowerCase();

    const ok = validateOwnedWalletTransferPrompt(`Transfer 50 USDC to ${verifiedSub}`, [primary, verifiedSub]);
    expect(ok.allowed).toBe(true);
    expect(ok.verifiedDestination).toBe(verifiedSub);

    const blocked = validateOwnedWalletTransferPrompt(`Transfer 50 USDC to ${stranger}`, [primary, verifiedSub]);
    expect(blocked.allowed).toBe(false);
    expect(blocked.code).toBe('TRANSFER_DESTINATION_NOT_WHITELISTED');
  });

  test('verifies route, db-pool, and Billing UI wiring (zero DDL migration)', () => {
    const routeSrc = fs.readFileSync(
      path.join(process.cwd(), 'app/api/user/owned-wallets/route.ts'),
      'utf8'
    );
    const chatSrc = fs.readFileSync(
      path.join(process.cwd(), 'app/api/agent/copilot/chat/route.ts'),
      'utf8'
    );
    const confirmSrc = fs.readFileSync(
      path.join(process.cwd(), 'app/api/agent/copilot/confirm/route.ts'),
      'utf8'
    );
    const bankrSrc = fs.readFileSync(
      path.join(process.cwd(), 'app/api/agent/bankr-prompt/route.ts'),
      'utf8'
    );
    const billingSrc = fs.readFileSync(
      path.join(process.cwd(), 'app/billing/page.tsx'),
      'utf8'
    );

    expect(routeSrc).toContain('verifyOwnedSubWalletProof');
    expect(routeSrc).toContain('linkVerifiedOwnedSubWallet');
    expect(chatSrc).toContain('listUserOwnedWallets');
    expect(confirmSrc).toContain('listUserOwnedWallets');
    expect(bankrSrc).toContain('listUserOwnedWallets');
    expect(billingSrc).toContain('OwnedWalletsAllowlistPanel');
  });
});
