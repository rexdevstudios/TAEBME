import { describe, it, expect, beforeEach } from 'bun:test';
import { NextRequest } from 'next/server';
import { PostgresBinanceExecutionDbAdapter } from '../packages/shared/db-pool';
import { BinanceCredentialVault } from '../packages/trading/binance-vault';
import {
  GET as getBinanceCreds,
  POST as postBinanceCreds,
  PATCH as patchBinanceCreds,
  DELETE as deleteBinanceCreds,
} from '../app/api/user/binance-credentials/route';

describe('Phase P1–P4: Multi-Account Binance CEX Vault & Non-Withdrawal Security Suite', () => {
  const TEST_MASTER_KEY = 'a'.repeat(64);
  const USER_A = '0x1111111111111111111111111111111111111111';
  const USER_B = '0x2222222222222222222222222222222222222222';
  let adapter: PostgresBinanceExecutionDbAdapter;

  beforeEach(() => {
    adapter = new PostgresBinanceExecutionDbAdapter(null, { inMemory: true });
    adapter.clearInMemoryState();
  });

  it('[P2.1] API /api/user/binance-credentials fails closed (401) without SIWE session across GET/POST/PATCH/DELETE', async () => {
    const getRes = await getBinanceCreds(new NextRequest('http://localhost/api/user/binance-credentials', { method: 'GET' }));
    expect(getRes.status).toBe(401);

    const postRes = await postBinanceCreds(
      new NextRequest('http://localhost/api/user/binance-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Test', apiKey: 'bn_test_key_1234', secretKey: 'bn_secret_key_5678' }),
      })
    );
    expect(postRes.status).toBe(401);

    const patchRes = await patchBinanceCreds(
      new NextRequest('http://localhost/api/user/binance-credentials', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credentialId: '00000000-0000-0000-0000-000000000001' }),
      })
    );
    expect(patchRes.status).toBe(401);

    const delRes = await deleteBinanceCreds(
      new NextRequest('http://localhost/api/user/binance-credentials?credentialId=00000000-0000-0000-0000-000000000001', {
        method: 'DELETE',
      })
    );
    expect(delRes.status).toBe(401);
  });

  it('[P2.2] Anti-Withdrawal Guard strictly rejects Binance credentials with withdraw=true', async () => {
    await expect(
      adapter.addBinanceCredential({
        userId: USER_A,
        label: 'Dangerous Withdraw Key',
        rawApiKey: 'bn_live_api_key_99998888',
        rawSecretKey: 'bn_live_secret_key_77776666',
        environment: 'MAINNET',
        permissions: { read: true, trade: true, withdraw: true },
        customMasterKeyHex: TEST_MASTER_KEY,
      })
    ).rejects.toThrow(/SECURITY_REJECT_WITHDRAWAL_KEY/);
  });

  it('[P2.3] Non-Custodial Guard (AGENTS.md Rule 3) rejects EVM private keys & BIP-39 mnemonics', async () => {
    const fakePrivateKey = '0x' + 'ab'.repeat(32);
    await expect(
      adapter.addBinanceCredential({
        userId: USER_A,
        label: 'Accidental PK',
        rawApiKey: fakePrivateKey,
        rawSecretKey: 'bn_secret_key_valid_9999',
        customMasterKeyHex: TEST_MASTER_KEY,
      })
    ).rejects.toThrow(/FORBIDDEN_PRIVATE_KEY_INPUT/);

    const fakeMnemonic = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
    await expect(
      adapter.addBinanceCredential({
        userId: USER_A,
        label: 'Accidental Seed',
        rawApiKey: 'bn_api_key_valid_1234',
        rawSecretKey: fakeMnemonic,
        customMasterKeyHex: TEST_MASTER_KEY,
      })
    ).rejects.toThrow(/FORBIDDEN_PRIVATE_KEY_INPUT/);
  });

  it('[P2.4] Multi-Account Isolation, Default Switching, Worker Decrypt Compatibility, & Soft Revoke', async () => {
    const acc1 = await adapter.addBinanceCredential({
      userId: USER_A,
      label: 'Binance Testnet Main',
      rawApiKey: 'bn_test_key_alpha_1111',
      rawSecretKey: 'bn_test_sec_alpha_2222',
      environment: 'TESTNET',
      customMasterKeyHex: TEST_MASTER_KEY,
    });
    const acc2 = await adapter.addBinanceCredential({
      userId: USER_A,
      label: 'Binance Scalp Bot',
      rawApiKey: 'bn_main_key_beta_3333',
      rawSecretKey: 'bn_main_sec_beta_4444',
      environment: 'MAINNET',
      customMasterKeyHex: TEST_MASTER_KEY,
    });

    // Write-only check: list never exposes raw/encrypted keys
    const listA = await adapter.listBinanceCredentials(USER_A);
    expect(listA.length).toBe(2);
    expect((listA[0] as any).encryptedApiKey).toBeUndefined();
    expect((listA[0] as any).encryptedSecretKey).toBeUndefined();
    expect(listA[0].maskedApiKey).toBe('bn_t••••1111');
    expect(acc1.isDefault).toBe(true);
    expect(acc2.isDefault).toBe(false);

    // Cross-user isolation: User B cannot access, setDefault, or revoke User A's account
    const crossFetch = await adapter.getBinanceCredentials(USER_B, acc1.id);
    expect(crossFetch).toBeNull();
    expect(await adapter.setDefaultBinanceCredential(USER_B, acc2.id)).toBe(false);
    expect(await adapter.revokeBinanceCredential(USER_B, acc1.id)).toBe(false);

    // Switch default to acc2 & verify worker decryption compatibility
    expect(await adapter.setDefaultBinanceCredential(USER_A, acc2.id)).toBe(true);
    const resolvedDefault = await adapter.getBinanceCredentials(USER_A);
    expect(resolvedDefault?.id).toBe(acc2.id);
    expect(resolvedDefault?.environment).toBe('MAINNET');

    const decryptedApiKey = await BinanceCredentialVault.decrypt(
      resolvedDefault.encryptedApiKey,
      TEST_MASTER_KEY,
      USER_A,
      resolvedDefault.id,
      adapter
    );
    const decryptedSecret = await BinanceCredentialVault.decrypt(
      resolvedDefault.encryptedSecretKey,
      TEST_MASTER_KEY,
      USER_A,
      resolvedDefault.id,
      adapter
    );
    expect(decryptedApiKey).toBe('bn_main_key_beta_3333');
    expect(decryptedSecret).toBe('bn_main_sec_beta_4444');

    // Revoke acc2 -> no longer returned
    expect(await adapter.revokeBinanceCredential(USER_A, acc2.id)).toBe(true);
    expect(await adapter.getBinanceCredentials(USER_A, acc2.id)).toBeNull();
    expect((await adapter.listBinanceCredentials(USER_A)).length).toBe(1);
  });

  it('[P2.5] Enforces maximum 10 active Binance accounts per user', async () => {
    for (let i = 1; i <= 10; i++) {
      await adapter.addBinanceCredential({
        userId: USER_A,
        label: `Binance Account ${i}`,
        rawApiKey: `bn_key_slot_${i}_abcdef`,
        rawSecretKey: `bn_sec_slot_${i}_123456`,
        customMasterKeyHex: TEST_MASTER_KEY,
      });
    }

    await expect(
      adapter.addBinanceCredential({
        userId: USER_A,
        label: 'Binance Account 11',
        rawApiKey: 'bn_key_slot_11_abcdef',
        rawSecretKey: 'bn_sec_slot_11_123456',
        customMasterKeyHex: TEST_MASTER_KEY,
      })
    ).rejects.toThrow(/MAX_KEYS_REACHED/);
  });
});
