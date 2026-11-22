#!/usr/bin/env bun
/**
 * scripts/test-siwe-e2e-smoke.ts
 *
 * Authenticated Burner-Wallet SIWE End-to-End Smoke Suite (Phase AO).
 * - Uses an ephemeral random wallet (`ethers.Wallet.createRandom()`) — ZERO real funds, ZERO stored keys.
 * - Defaults strictly to Testnet (`https://testnet.pndigi.site`).
 * - Verifies full authenticated lifecycle:
 *     SIWE challenge -> EIP-191 sign -> verify -> vault-summary -> Bybit testnet add ->
 *     Bybit mainnet 403 gate -> vault-summary active=1 -> PAPER execute -> revoke cleanup -> logout.
 */

import { ethers } from 'ethers';

const BASE_URL = process.env.TEST_TARGET_URL || 'https://testnet.pndigi.site';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (!condition) {
    console.error(`  ❌ FAILED: ${label}`);
    failed += 1;
    throw new Error(`SIWE E2E Assertion Failed: ${label}`);
  }
  console.log(`  ✓ ${label}`);
  passed += 1;
}

async function runSiweE2eSmoke() {
  console.log('================================================================');
  console.log('  AUTHENTICATED SIWE E2E SMOKE SUITE (EPHEMERAL BURNER WALLET)');
  console.log(`  Target: ${BASE_URL}`);
  console.log('================================================================\n');

  const burner = ethers.Wallet.createRandom();
  const walletAddress = burner.address;
  let sessionToken = '';
  let createdBybitKeyId: string | null = null;

  try {
    // 1. SIWE Challenge
    const chalRes = await fetch(`${BASE_URL}/api/auth/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress }),
    });
    const chalJson: any = await chalRes.json();
    assert(chalRes.status === 200 && chalJson?.success === true, `POST /api/auth/challenge returns HTTP 200 (Got ${chalRes.status})`);
    const { nonce, messageToSign } = chalJson.data || {};
    assert(typeof nonce === 'string' && nonce.length >= 8 && typeof messageToSign === 'string', 'Challenge issued valid nonce & SIWE message');

    // 2. Local EIP-191 Sign
    const signature = await burner.signMessage(messageToSign);
    assert(signature.startsWith('0x') && signature.length >= 130, 'Ephemeral burner wallet signed SIWE message (EIP-191)');

    // 3. SIWE Verify -> Session Token
    const verifyRes = await fetch(`${BASE_URL}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress, signature, nonce, message: messageToSign }),
    });
    const verifyJson: any = await verifyRes.json();
    assert(verifyRes.status === 200 && verifyJson?.success === true, `POST /api/auth/verify returns HTTP 200 (Got ${verifyRes.status})`);
    sessionToken = String(verifyJson?.data?.sessionToken || '');
    assert(sessionToken.length > 20, 'Received signed HMAC sessionToken');

    const authHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sessionToken}`,
    };

    // 4. Initial Vault Summary (clean state)
    const sum1Res = await fetch(`${BASE_URL}/api/user/vault-summary`, { headers: authHeaders });
    const sum1Json: any = await sum1Res.json();
    assert(sum1Res.status === 200 && sum1Json?.success === true, `GET /api/user/vault-summary returns HTTP 200 (Got ${sum1Res.status})`);
    assert(sum1Json?.data?.planId === 'FREE' && sum1Json?.data?.vaults?.bybit?.active === 0, 'Fresh burner account starts on FREE tier with 0 active Bybit keys');

    // 5. Add Bybit V5 Testnet Key (write-only AES-256-GCM)
    const dummyApiKey = `smoke_bybit_key_${Date.now()}`;
    const dummySecret = `smoke_bybit_secret_${Date.now()}`;
    const addTestRes = await fetch(`${BASE_URL}/api/user/provider-keys`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        provider: 'BYBIT',
        label: 'SIWE Smoke Testnet',
        apiKey: `${dummyApiKey}:${dummySecret}`,
        chainScope: 'testnet',
        isDefault: true,
      }),
    });
    const addTestJson: any = await addTestRes.json();
    assert(
      (addTestRes.status === 201 || addTestRes.status === 200) && addTestJson?.success === true,
      `POST /api/user/provider-keys (BYBIT testnet) succeeded (Got HTTP ${addTestRes.status})`
    );
    createdBybitKeyId = String(addTestJson?.data?.id || '');
    assert(Boolean(createdBybitKeyId), 'Stored Bybit key returned valid UUID');
    assert(!JSON.stringify(addTestJson).includes(dummySecret), 'Write-only vault NEVER echoes raw secret in response');

    // 6. Attempt Bybit Mainnet Key on FREE tier -> must be 403 PLAN_MAINNET_REQUIRED
    const addMainRes = await fetch(`${BASE_URL}/api/user/provider-keys`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        provider: 'BYBIT',
        label: 'SIWE Smoke Mainnet',
        apiKey: `${dummyApiKey}:${dummySecret}`,
        chainScope: 'mainnet',
      }),
    });
    assert(addMainRes.status === 403, `POST /api/user/provider-keys (BYBIT mainnet on FREE) rejected with HTTP 403 (Got ${addMainRes.status})`);

    // 7. Vault Summary reflects active=1
    const sum2Res = await fetch(`${BASE_URL}/api/user/vault-summary`, { headers: authHeaders });
    const sum2Json: any = await sum2Res.json();
    assert(sum2Res.status === 200 && sum2Json?.data?.vaults?.bybit?.active === 1, 'Vault summary live counter incremented to bybit.active === 1');

    // 8. Authenticated PAPER Execution via Risk Gate
    const execRes = await fetch(`${BASE_URL}/api/trading/execute`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        executionMode: 'PAPER',
        stage: 'PAPER',
        symbol: 'BTCUSDT',
        side: 'BUY',
        type: 'MARKET',
        quantity: 0.01,
        maxSlippagePct: 1.0,
      }),
    });
    const execJson: any = await execRes.json();
    assert(execRes.status === 200 && execJson?.success === true && execJson?.data?.status === 'FILLED_SIMULATED', `POST /api/trading/execute (PAPER) approved & simulated (Got HTTP ${execRes.status})`);
  } finally {
    // 9. Auto-Cleanup: Revoke test key & verify count returns to 0 + logout
    if (sessionToken && createdBybitKeyId) {
      const authHeaders = { Authorization: `Bearer ${sessionToken}` };
      const delRes = await fetch(`${BASE_URL}/api/user/provider-keys?keyId=${encodeURIComponent(createdBybitKeyId)}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      assert(delRes.status === 200, `Cleanup DELETE /api/user/provider-keys succeeded (Got HTTP ${delRes.status})`);

      const sum3Res = await fetch(`${BASE_URL}/api/user/vault-summary`, { headers: authHeaders });
      const sum3Json: any = await sum3Res.json();
      assert(sum3Res.status === 200 && sum3Json?.data?.vaults?.bybit?.active === 0, 'Post-cleanup vault summary returned to bybit.active === 0');
    }
    if (sessionToken) {
      await fetch(`${BASE_URL}/api/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${sessionToken}` },
      }).catch(() => {});
    }
  }

  console.log('\n================================================================');
  console.log(`  🎉 SIWE E2E SMOKE COMPLETED: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================\n');
  if (failed > 0) process.exit(1);
}

runSiweE2eSmoke().catch((err) => {
  console.error('SIWE E2E smoke suite failed:', err?.message || err);
  process.exit(1);
});
