import { describe, expect, it } from 'bun:test';
import {
  encryptSecret,
  decryptSecret,
  maskApiKey,
  assertNotPrivateKeyOrMnemonic,
  assertChainScopeMatches,
  validateMultiChainFeeRecipient,
} from '../packages/shared/credential-vault';
import { PostgresProviderKeyVaultAdapter } from '../packages/shared/db-pool';
import { GET as getProviderKeys, POST as postProviderKeys } from '../app/api/user/provider-keys/route';
import { NextRequest } from 'next/server';

describe('Phase O1–O4 — Multi-Key BYOK Bankr Vault (AES-256-GCM) & Multi-Chain Security', () => {
  it('O1.1 — encrypts & decrypts service API keys with AES-256-GCM and detects authTag tampering', () => {
    const rawKey = 'bk_live_9876543210abcdef12345678';
    const enc = encryptSecret(rawKey, 'unit-test-master-secret');
    expect(enc.ciphertext).not.toContain('bk_live');
    expect(enc.iv.length).toBeGreaterThan(8);
    expect(enc.authTag.length).toBeGreaterThan(8);

    const dec = decryptSecret(enc, 'unit-test-master-secret');
    expect(dec).toBe(rawKey);

    // Tampered authTag or wrong master key must throw
    expect(() =>
      decryptSecret({ ...enc, authTag: Buffer.alloc(16, 1).toString('base64') }, 'unit-test-master-secret')
    ).toThrow(/VAULT_DECRYPT_TAMPERED/);
    expect(() => decryptSecret(enc, 'wrong-master-secret')).toThrow(/VAULT_DECRYPT_TAMPERED/);

    // Masked display never exposes middle characters
    expect(maskApiKey(rawKey)).toBe('bk_l••••5678');
  });

  it('O1.2 — strictly rejects EVM private keys, Solana keypair arrays, and BIP-39 seed phrases (AGENTS.md Rule 3)', () => {
    const evmPrivKeyWith0x = '0x' + 'a'.repeat(64);
    const evmPrivKeyRaw = 'b'.repeat(64);
    const solKeypairJson = '[' + Array.from({ length: 64 }, (_, i) => i + 1).join(',') + ']';
    const mnemonic12 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

    expect(() => assertNotPrivateKeyOrMnemonic(evmPrivKeyWith0x)).toThrow(/FORBIDDEN_PRIVATE_KEY_INPUT/);
    expect(() => assertNotPrivateKeyOrMnemonic(evmPrivKeyRaw)).toThrow(/FORBIDDEN_PRIVATE_KEY_INPUT/);
    expect(() => assertNotPrivateKeyOrMnemonic(solKeypairJson)).toThrow(/FORBIDDEN_PRIVATE_KEY_INPUT/);
    expect(() => assertNotPrivateKeyOrMnemonic(mnemonic12)).toThrow(/FORBIDDEN_PRIVATE_KEY_INPUT/);

    // Legitimate Bankr API key passes
    expect(() => assertNotPrivateKeyOrMnemonic('bk_live_prod_key_2026_xyz987')).not.toThrow();
  });

  it('O2.1 — enforces multi-chain blast-radius scope (CHAIN_SCOPE_MISMATCH) and cross-chain feeRecipient format', () => {
    // Key scoped to 'robinhood' cannot deploy on 'base'
    expect(() => assertChainScopeMatches('robinhood', 'base')).toThrow(/CHAIN_SCOPE_MISMATCH/);
    expect(() => assertChainScopeMatches('robinhood', 'robinhood-mainnet')).not.toThrow();
    expect(() => assertChainScopeMatches('all', 'base')).not.toThrow();
    expect(() => assertChainScopeMatches('all', 'arbitrum')).not.toThrow();

    // EVM chains reject non-EVM Solana Base58 wallet addresses as feeRecipient
    expect(() =>
      validateMultiChainFeeRecipient('base', {
        type: 'wallet',
        value: 'So11111111111111111111111111111111111111112',
      })
    ).toThrow(/CROSS_CHAIN_ADDRESS_MISMATCH/);

    // Valid EVM address and social handle pass
    expect(() =>
      validateMultiChainFeeRecipient('base', {
        type: 'wallet',
        value: '0x814620255bf422d45c0f8aBF7ad89F40a1CBCA4A',
      })
    ).not.toThrow();
    expect(() =>
      validateMultiChainFeeRecipient('robinhood', {
        type: 'x',
        value: '@poolnet_kol',
      })
    ).not.toThrow();
  });

  it('O2.2 — isolates multi-key BYOK vault per user account (User B cannot access or revoke User A keys)', async () => {
    const vault = new PostgresProviderKeyVaultAdapter();
    const userA = '0xaaa0000000000000000000000000000000000001';
    const userB = '0xbbb0000000000000000000000000000000000002';

    const keyA1 = await vault.addKey({
      userIdentifier: userA,
      label: 'Bankr Base Key 1',
      rawApiKey: 'bk_userA_base_key_11112222',
      chainScope: 'base',
      isDefault: true,
    });
    const keyA2 = await vault.addKey({
      userIdentifier: userA,
      label: 'Bankr Robinhood Key 2',
      rawApiKey: 'bk_userA_rh_key_33334444',
      chainScope: 'robinhood',
      isDefault: false,
    });

    const listA = await vault.listKeys(userA, 'BANKR');
    expect(listA.length).toBeGreaterThanOrEqual(2);
    expect((listA[0] as any).encryptedApiKey).toBeUndefined(); // Write-only guarantee

    // User B sees 0 of User A's keys
    const listB = await vault.listKeys(userB, 'BANKR');
    expect(listB.find((k) => k.id === keyA1.id)).toBeUndefined();

    // User B cannot decrypt or revoke User A's key
    await expect(
      vault.resolveDecryptedKeyForDeploy({
        userIdentifier: userB,
        targetChain: 'base',
        keyId: keyA1.id,
      })
    ).rejects.toThrow(/BYOK_KEY_NOT_FOUND_OR_FORBIDDEN/);

    const revokedByB = await vault.revokeKey(userB, keyA1.id);
    expect(revokedByB).toBe(false);

    // User A cannot use Robinhood-scoped keyA2 on Base chain
    await expect(
      vault.resolveDecryptedKeyForDeploy({
        userIdentifier: userA,
        targetChain: 'base',
        keyId: keyA2.id,
      })
    ).rejects.toThrow(/CHAIN_SCOPE_MISMATCH/);

    // User A can use Base-scoped keyA1 on Base chain
    const resolvedA1 = await vault.resolveDecryptedKeyForDeploy({
      userIdentifier: userA,
      targetChain: 'base',
      keyId: keyA1.id,
    });
    expect(resolvedA1?.apiKey).toBe('bk_userA_base_key_11112222');
  });

  it('O3.1 — GET & POST /api/user/provider-keys fail closed (401) without SIWE session', async () => {
    const getReq = new NextRequest('https://testnet.pndigi.site/api/user/provider-keys?provider=BANKR');
    const getRes = await getProviderKeys(getReq);
    expect(getRes.status).toBe(401);

    const postReq = new NextRequest('https://testnet.pndigi.site/api/user/provider-keys', {
      method: 'POST',
      body: JSON.stringify({ label: 'Test', apiKey: 'bk_test_1234567890' }),
    });
    const postRes = await postProviderKeys(postReq);
    expect(postRes.status).toBe(401);
  });
});
