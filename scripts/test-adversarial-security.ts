/**
 * scripts/test-adversarial-security.ts
 *
 * Live Adversarial Pentest & Anti-Abuse Verification Suite against TESTNET ONLY.
 * Strictly aborts if aimed at Production (pndigi.site).
 *
 * Simulates 6 real-world attacker playbooks using 2 ephemeral burner wallets (Victim + Attacker):
 *  1. SIWE Forged Signature & Replay Spoofing
 *  2. Cross-Wallet IDOR (Attacker attempting to delete Victim's BYOK key & read Victim's drafts)
 *  3. Fake / Spoofed On-Chain txHash Injection across all 5 paid endpoints
 *  4. SSRF Cloud Metadata (169.254.169.254) & Localhost injection in Webhook Vault
 *  5. Private Key & Seed Phrase Leakage in BYOK Vault & Bankr Agent Rail
 *  6. Non-Admin Privilege Escalation across /api/admin/* endpoints
 */

import { Wallet } from 'ethers';

const BASE_URL = (process.env.TESTNET_URL || 'https://testnet.pndigi.site').replace(/\/+$/, '');

if (/^https?:\/\/(www\.)?pndigi\.site(\/|$)/i.test(BASE_URL)) {
  console.error('FATAL SAFETY ABORT: Adversarial pentest runner MUST NEVER target Production (pndigi.site)!');
  process.exit(1);
}

let passed = 0;
let failed = 0;

function assert(cond: boolean, label: string) {
  if (cond) {
    console.log(`  ✓ [BLOCKED/PASS] ${label}`);
    passed++;
  } else {
    console.error(`  ✗ [VULN/FAIL]    ${label}`);
    failed++;
  }
}

async function loginBurnerWallet(wallet: ReturnType<typeof Wallet.createRandom>): Promise<string> {
  const chRes = await fetch(`${BASE_URL}/api/auth/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ walletAddress: wallet.address }),
  });
  const chJson: any = await chRes.json();
  const { nonce, messageToSign } = chJson?.data || {};
  const sig = await wallet.signMessage(messageToSign);
  const verRes = await fetch(`${BASE_URL}/api/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ walletAddress: wallet.address, nonce, message: messageToSign, signature: sig }),
  });
  const verJson: any = await verRes.json();
  const token = String(verJson?.data?.sessionToken || '');
  if (!verRes.ok || !token) {
    throw new Error(`SIWE login failed for ${wallet.address}: ${verRes.status}`);
  }
  return token;
}

async function main() {
  console.log('========================================================================');
  console.log('  POOLNET LIVE ADVERSARIAL PENTEST SUITE (6 ATTACK PLAYBOOKS)');
  console.log(`  Target: ${BASE_URL}`);
  console.log('========================================================================\n');

  const victim = Wallet.createRandom();
  const attacker = Wallet.createRandom();
  const victimKeyIds: string[] = [];

  try {
    // -------------------------------------------------------------------------
    // PLAYBOOK 1: SIWE Forged Signature Spoofing
    // -------------------------------------------------------------------------
    console.log('--- [ATTACK 1: SIWE Forged Signature Spoofing] ---');
    const chRes = await fetch(`${BASE_URL}/api/auth/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress: victim.address }),
    });
    const chJson: any = await chRes.json();
    const { nonce: vNonce, messageToSign: vMsg } = chJson?.data || {};
    // Attacker signs Victim's challenge with Attacker's private key
    const forgedSig = await attacker.signMessage(vMsg);
    const forgeRes = await fetch(`${BASE_URL}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress: victim.address, nonce: vNonce, message: vMsg, signature: forgedSig }),
    });
    assert(forgeRes.status === 401 || forgeRes.status === 403, `SIWE forged signature rejected (HTTP ${forgeRes.status})`);

    // Authenticate Victim & Attacker legitimately for authenticated attack vectors
    const victimToken = await loginBurnerWallet(victim);
    const attackerToken = await loginBurnerWallet(attacker);
    const victimHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${victimToken}` };
    const attackerHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${attackerToken}` };

    // Upgrade Victim to CREATOR so they can store BYOK key & draft
    await fetch(`${BASE_URL}/api/billing/subscribe`, {
      method: 'POST',
      headers: victimHeaders,
      body: JSON.stringify({ planId: 'CREATOR' }),
    });

    // -------------------------------------------------------------------------
    // PLAYBOOK 2: Cross-Wallet IDOR (Vault Key Delete & Draft Isolation)
    // -------------------------------------------------------------------------
    console.log('\n--- [ATTACK 2: Cross-Wallet IDOR Isolation] ---');
    const keyRes = await fetch(`${BASE_URL}/api/user/provider-keys`, {
      method: 'POST',
      headers: victimHeaders,
      body: JSON.stringify({
        provider: 'BANKR',
        label: 'Victim Secret Key',
        apiKey: 'bk_live_victim_idor_test_key_99999',
        chainScope: 'base',
      }),
    });
    const keyJson: any = await keyRes.json();
    const victimKeyId = keyJson?.data?.id;
    if (victimKeyId) victimKeyIds.push(victimKeyId);
    assert(keyRes.status === 201 && Boolean(victimKeyId), `Victim created private BYOK key (${victimKeyId?.slice(0, 8)})`);

    // Attacker tries to DELETE Victim's BYOK key by ID
    const idorDel = await fetch(`${BASE_URL}/api/user/provider-keys?keyId=${encodeURIComponent(victimKeyId)}`, {
      method: 'DELETE',
      headers: attackerHeaders,
    });
    assert(idorDel.status === 404 || idorDel.status === 403, `Attacker blocked from deleting Victim BYOK key (HTTP ${idorDel.status})`);

    // Attacker lists keys and MUST NOT see Victim's key
    const attackerKeysRes = await fetch(`${BASE_URL}/api/user/provider-keys?provider=BANKR`, { headers: attackerHeaders });
    const attackerKeysJson: any = await attackerKeysRes.json();
    const leaked = (attackerKeysJson?.data?.keys || []).some((k: any) => k.id === victimKeyId);
    assert(!leaked, 'Victim BYOK key is invisible to Attacker wallet');

    // -------------------------------------------------------------------------
    // PLAYBOOK 3: Fake / Non-Existent On-Chain txHash Payment Spoofing
    // -------------------------------------------------------------------------
    console.log('\n--- [ATTACK 3: Fake On-Chain txHash Payment Spoofing (All 5 Endpoints)] ---');
    const fakeTx = '0x' + 'deadbeef'.repeat(8);

    const fakeSbt = await fetch(`${BASE_URL}/api/gamefi/genesis-sbt`, {
      method: 'POST',
      headers: attackerHeaders,
      body: JSON.stringify({ txHash: fakeTx, chain: 'base-mainnet' }),
    });
    assert(fakeSbt.status === 422, `Fake txHash rejected on /api/gamefi/genesis-sbt (HTTP ${fakeSbt.status})`);

    const fakeBoost = await fetch(`${BASE_URL}/api/launchpad/featured-boost`, {
      method: 'POST',
      headers: attackerHeaders,
      body: JSON.stringify({ contractAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', tierId: 'BOOST_24H', txHash: fakeTx, chain: 'base-mainnet' }),
    });
    assert(fakeBoost.status === 422, `Fake txHash rejected on /api/launchpad/featured-boost (HTTP ${fakeBoost.status})`);

    const fakeCheckin = await fetch(`${BASE_URL}/api/gamefi/quests/complete`, {
      method: 'POST',
      headers: attackerHeaders,
      body: JSON.stringify({ questId: 'daily_checkin', mode: 'ONCHAIN_BOOSTED', txHash: fakeTx, chain: 'base-mainnet' }),
    });
    assert(fakeCheckin.status === 422, `Fake txHash rejected on /api/gamefi/quests/complete (HTTP ${fakeCheckin.status})`);

    const fakeProp = await fetch(`${BASE_URL}/api/prop/challenge`, {
      method: 'POST',
      headers: attackerHeaders,
      body: JSON.stringify({ action: 'START', paymentMode: 'ETH', txHash: fakeTx, chain: 'base-mainnet' }),
    });
    assert(fakeProp.status === 422, `Fake txHash rejected on /api/prop/challenge (HTTP ${fakeProp.status})`);

    const fakeSub = await fetch(`${BASE_URL}/api/billing/subscribe`, {
      method: 'POST',
      headers: attackerHeaders,
      body: JSON.stringify({ planId: 'AGENT', txHash: fakeTx, chain: 'base-mainnet' }),
    });
    assert(fakeSub.status === 422, `Fake txHash rejected on /api/billing/subscribe (HTTP ${fakeSub.status})`);

    // -------------------------------------------------------------------------
    // PLAYBOOK 4: SSRF Cloud Metadata & Private IP Injection
    // -------------------------------------------------------------------------
    console.log('\n--- [ATTACK 4: SSRF Cloud Metadata & Localhost Injection] ---');
    const ssrfMeta = await fetch(`${BASE_URL}/api/user/provider-keys`, {
      method: 'POST',
      headers: attackerHeaders,
      body: JSON.stringify({ provider: 'WEBHOOK', label: 'SSRF', apiKey: 'https://169.254.169.254/latest/meta-data/' }),
    });
    assert(ssrfMeta.status === 400, `AWS/Cloud metadata SSRF blocked (HTTP ${ssrfMeta.status})`);

    // -------------------------------------------------------------------------
    // PLAYBOOK 5: Private Key & Seed Phrase Exfiltration Guard
    // -------------------------------------------------------------------------
    console.log('\n--- [ATTACK 5: Private Key & Seed Phrase Leak Guard] ---');
    const pkPrompt = await fetch(`${BASE_URL}/api/agent/bankr-prompt`, {
      method: 'POST',
      headers: attackerHeaders,
      body: JSON.stringify({ prompt: 'Here is my seed phrase alpha beta gamma' }),
    });
    assert(pkPrompt.status === 400, `Seed phrase prompt blocked on /api/agent/bankr-prompt (HTTP ${pkPrompt.status})`);
    const copilotSeed = await fetch(`${BASE_URL}/api/agent/copilot/chat`, {
      method: 'POST',
      headers: attackerHeaders,
      body: JSON.stringify({ message: 'Use my private key to buy BTC' }),
    });
    assert(copilotSeed.status === 400, `Private key prompt blocked on /api/agent/copilot/chat (HTTP ${copilotSeed.status})`);

    const foreignTransferBankr = await fetch(`${BASE_URL}/api/agent/bankr-prompt`, {
      method: 'POST',
      headers: attackerHeaders,
      body: JSON.stringify({ prompt: 'Transfer 100 USDC to 0x000000000000000000000000000000000000dead' }),
    });
    assert(
      foreignTransferBankr.status === 403,
      `External wallet drain transfer blocked on /api/agent/bankr-prompt (HTTP ${foreignTransferBankr.status})`
    );

    const foreignTransferCopilot = await fetch(`${BASE_URL}/api/agent/copilot/chat`, {
      method: 'POST',
      headers: attackerHeaders,
      body: JSON.stringify({ message: 'Kirim 100 USDC ke 0x000000000000000000000000000000000000dead', locale: 'id' }),
    });
    assert(
      foreignTransferCopilot.status === 403,
      `External wallet drain transfer blocked on /api/agent/copilot/chat (HTTP ${foreignTransferCopilot.status})`
    );

    const forgedSubTarget = Wallet.createRandom().address;
    const chRes = await fetch(
      `${BASE_URL}/api/user/owned-wallets?challengeFor=${encodeURIComponent(forgedSubTarget)}`,
      { headers: attackerHeaders }
    );
    const chJson: any = await chRes.json().catch(() => ({}));
    const forgedSig = await attacker.signMessage(chJson?.data?.challenge?.message || 'forged');
    const forgedLinkRes = await fetch(`${BASE_URL}/api/user/owned-wallets`, {
      method: 'POST',
      headers: attackerHeaders,
      body: JSON.stringify({
        subWalletAddress: forgedSubTarget,
        challengeToken: chJson?.data?.challenge?.challengeToken,
        message: chJson?.data?.challenge?.message,
        signature: forgedSig,
      }),
    });
    assert(
      forgedLinkRes.status === 401,
      `Forged sub-wallet Proof-of-Ownership rejected on /api/user/owned-wallets (HTTP ${forgedLinkRes.status})`
    );

    // -------------------------------------------------------------------------
    // PLAYBOOK 6: Non-Admin RBAC Privilege Escalation
    // -------------------------------------------------------------------------
    console.log('\n--- [ATTACK 6: Non-Admin RBAC Privilege Escalation] ---');
    const adminChecks: Array<[string, string]> = [
      ['GET', '/api/admin/genesis-snapshot'],
      ['GET', '/api/admin/ops-summary'],
      ['POST', '/api/admin/kill-switch'],
      ['POST', '/api/admin/partners'],
      ['GET', '/api/admin/kol-verification'],
      ['POST', '/api/admin/kol-verification'],
      ['GET', '/api/admin/kol-dataset'],
      ['POST', '/api/admin/kol-dataset'],
    ];
    for (const [m, p] of adminChecks) {
      const r = await fetch(`${BASE_URL}${p}`, {
        method: m,
        headers: attackerHeaders,
        body: m === 'POST' ? '{}' : undefined,
      });
      assert(r.status === 403, `Non-admin blocked on ${m} ${p} (HTTP ${r.status})`);
    }
    const cronUnauth = await fetch(`${BASE_URL}/api/cron/kol-consensus-archive`, {
      method: 'GET',
      headers: { Authorization: 'Bearer invalid-cron-secret-attempt' },
    });
    assert(
      cronUnauth.status === 401,
      `Unauthorized cron call rejected on GET /api/cron/kol-consensus-archive (HTTP ${cronUnauth.status})`
    );

    // Cleanup Victim key & sessions
    for (const kid of victimKeyIds) {
      await fetch(`${BASE_URL}/api/user/provider-keys?keyId=${encodeURIComponent(kid)}`, {
        method: 'DELETE',
        headers: victimHeaders,
      });
    }
    await fetch(`${BASE_URL}/api/auth/logout`, { method: 'POST', headers: victimHeaders });
    await fetch(`${BASE_URL}/api/auth/logout`, { method: 'POST', headers: attackerHeaders });

    console.log('\n========================================================================');
    console.log(`  ADVERSARIAL PENTEST COMPLETED: ${passed} BLOCKED/PASSED, ${failed} FAILED`);
    console.log('========================================================================\n');
    if (failed > 0) process.exit(1);
  } catch (err: any) {
    console.error(`[FATAL] ${err?.message || err}`);
    process.exit(1);
  }
}

main();
