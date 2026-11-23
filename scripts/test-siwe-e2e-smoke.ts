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

    // 9. Trade Intents History reflects the executed PAPER order (Phase AP)
    const histRes = await fetch(`${BASE_URL}/api/trade-intents?limit=5`, { headers: authHeaders });
    const histJson: any = await histRes.json();
    const intentsList = Array.isArray(histJson?.data?.intents) ? histJson.data.intents : [];
    assert(
      histRes.status === 200 && histJson?.success === true && intentsList.some((it: any) => it?.symbol === 'BTCUSDT'),
      `GET /api/trade-intents?limit=5 returns persisted BTCUSDT order (Got HTTP ${histRes.status}, count=${intentsList.length})`
    );

    // 10. Autonomous 4-Sub-Agent Dual-Rail Telemetry + On-Demand Scout Refresh (Phase AR + AS + AZ)
    const termRes = await fetch(`${BASE_URL}/api/agent/terminal-telemetry?refreshScout=1`, { headers: authHeaders });
    const termJson: any = await termRes.json();
    assert(
      termRes.status === 200 &&
        termJson?.success === true &&
        Array.isArray(termJson?.data?.agentBreakdown) &&
        termJson.data.agentBreakdown.length === 4 &&
        termJson?.data?.dualRailReadiness?.externalDexZeroXReady === true,
      `GET /api/agent/terminal-telemetry?refreshScout=1 returns 4 sub-agents & externalDexZeroXReady=true (Got HTTP ${termRes.status})`
    );
    assert(
      Array.isArray(termJson?.data?.liveFeed) &&
        termJson.data.liveFeed.length >= 2 &&
        typeof termJson.data.liveFeed[0]?.href === 'string' &&
        termJson.data.liveFeed[0].href.startsWith('/trading?'),
      `On-demand Scout telemetry populates liveFeed (${termJson?.data?.liveFeed?.length} items) with 1-click /trading handoff URLs`
    );

    // 11. Multi-Chain ERC-7715 Session Allowance on Arbitrum 42161 with FREE-tier cap clamping (Phase AS + AT)
    const allowRes = await fetch(`${BASE_URL}/api/agent/session-allowance`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        delegateAddress: walletAddress,
        chainId: 42161,
        dailySpendCapUsd: 5000,
        allowedActions: ['SWAP_DEX'],
      }),
    });
    const allowJson: any = await allowRes.json();
    assert(
      allowRes.status === 200 &&
        allowJson?.success === true &&
        allowJson?.data?.chainId === 42161 &&
        allowJson?.data?.effectiveDailySpendCapUsd === 250,
      `POST /api/agent/session-allowance (Arbitrum 42161) clamped FREE cap to $250/day (Got HTTP ${allowRes.status}, cap=${allowJson?.data?.effectiveDailySpendCapUsd})`
    );

    // 12. Rule 3 Non-Custodial Guard: Reject 64-hex private key in session-allowance (Phase AS)
    const pkRes = await fetch(`${BASE_URL}/api/agent/session-allowance`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        delegateAddress: `0x${'a'.repeat(64)}`,
        chainId: 8453,
        dailySpendCapUsd: 50,
      }),
    });
    const pkJson: any = await pkRes.json();
    assert(
      pkRes.status === 400 && String(pkJson?.error || '').includes('FORBIDDEN_PRIVATE_KEY_INPUT'),
      `POST /api/agent/session-allowance rejects 64-hex private key with HTTP 400 FORBIDDEN_PRIVATE_KEY_INPUT (Got HTTP ${pkRes.status})`
    );

    // 13. Non-Custodial DEX Swap Quote & Partner Fee Payload (Phase AQ + AR)
    const dexRes = await fetch(`${BASE_URL}/api/trading/execute`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        executionMode: 'DEX_NON_CUSTODIAL',
        stage: 'PAPER',
        symbol: 'USDC',
        tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        chainId: 8453,
        side: 'BUY',
        type: 'MARKET',
        quantity: 0.01,
        maxSlippagePct: 1.0,
      }),
    });
    const dexJson: any = await dexRes.json();
    assert(
      dexRes.status === 200 && dexJson?.success === true && dexJson?.data?.status === 'READY_FOR_WALLET_SIGN',
      `POST /api/trading/execute (DEX_NON_CUSTODIAL Base USDC) returns READY_FOR_WALLET_SIGN (Got HTTP ${dexRes.status})`
    );
    assert(
      Boolean(dexJson?.data?.partnerFee && typeof dexJson.data.partnerFee.feeBps === 'number') &&
        Boolean(dexJson?.data?.zeroXSwap && typeof dexJson.data.zeroXSwap.available === 'boolean' && dexJson.data.zeroXSwap.chainId === 8453),
      `DEX_NON_CUSTODIAL payload includes partnerFee (${dexJson?.data?.partnerFee?.feeBps} bps) & zeroXSwap (available=${dexJson?.data?.zeroXSwap?.available}, chainId=${dexJson?.data?.zeroXSwap?.chainId})`
    );

    // 14. Multi-Chain Non-Custodial DEX Swap Quote on Arbitrum 42161 (Phase AT + BA + BB)
    const arbDexRes = await fetch(`${BASE_URL}/api/trading/execute`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        executionMode: 'DEX_NON_CUSTODIAL',
        stage: 'PAPER',
        symbol: 'USDC',
        tokenAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
        chainId: 42161,
        side: 'BUY',
        type: 'MARKET',
        quantity: 0.01,
        maxSlippagePct: 1.0,
      }),
    });
    const arbDexJson: any = await arbDexRes.json();
    assert(
      arbDexRes.status === 200 && arbDexJson?.success === true && arbDexJson?.data?.status === 'READY_FOR_WALLET_SIGN',
      `POST /api/trading/execute (DEX_NON_CUSTODIAL Arbitrum 42161 USDC) returns READY_FOR_WALLET_SIGN (Got HTTP ${arbDexRes.status})`
    );
    assert(
      Boolean(arbDexJson?.data?.partnerFee && arbDexJson.data.partnerFee.chainId === 42161) &&
        Boolean(arbDexJson?.data?.zeroXSwap && arbDexJson.data.zeroXSwap.chainId === 42161),
      `Arbitrum 42161 DEX payload includes partnerFee (${arbDexJson?.data?.partnerFee?.feeBps} bps) & zeroXSwap (available=${arbDexJson?.data?.zeroXSwap?.available}, chainId=${arbDexJson?.data?.zeroXSwap?.chainId})`
    );
    assert(
      Array.isArray(arbDexJson?.data?.zeroXSwap?.routeSources) &&
        arbDexJson.data.zeroXSwap.routeSources.length >= 1 &&
        BigInt(arbDexJson?.data?.zeroXSwap?.buyAmount || '0') > 0n,
      `Live 0x v2 quote includes positive buyAmount (${arbDexJson?.data?.zeroXSwap?.buyAmount}) & routeSources (${arbDexJson?.data?.zeroXSwap?.routeSources?.join('+')})`
    );

    // 15. Non-Custodial DEX SELL Quote includes ERC-20 AllowanceHolder target (Phase BC)
    const sellDexRes = await fetch(`${BASE_URL}/api/trading/execute`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        executionMode: 'DEX_NON_CUSTODIAL',
        stage: 'PAPER',
        symbol: 'USDC',
        tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        chainId: 8453,
        side: 'SELL',
        type: 'MARKET',
        quantity: 0.01,
        maxSlippagePct: 1.0,
      }),
    });
    const sellDexJson: any = await sellDexRes.json();
    assert(
      sellDexRes.status === 200 &&
        sellDexJson?.success === true &&
        typeof sellDexJson?.data?.zeroXSwap?.allowanceTarget === 'string' &&
        sellDexJson.data.zeroXSwap.allowanceTarget.startsWith('0x') &&
        sellDexJson?.data?.zeroXSwap?.sellToken === '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      `POST /api/trading/execute (DEX_NON_CUSTODIAL SELL Base USDC) returns valid ERC-20 allowanceTarget (${sellDexJson?.data?.zeroXSwap?.allowanceTarget})`
    );
    assert(
      sellDexJson?.data?.zeroXSwap?.sellAmount === '10000',
      `SELL 0.01 Base USDC resolves 6-decimal atomic sellAmount === "10000" (Got ${sellDexJson?.data?.zeroXSwap?.sellAmount})`
    );

    // 16. Confirm On-Chain DEX Settlement via PATCH /api/trade-intents & verify EXECUTED + Explorer key (Phase BF)
    const arbIntentId = String(arbDexJson?.data?.tradeIntentId || '');
    const simulatedArbTxHash = `0x${'e'.repeat(64)}`;
    const patchRes = await fetch(`${BASE_URL}/api/trade-intents`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({
        tradeIntentId: arbIntentId,
        txHash: simulatedArbTxHash,
        chainId: 42161,
      }),
    });
    const patchJson: any = await patchRes.json();
    assert(
      patchRes.status === 200 &&
        patchJson?.success === true &&
        patchJson?.data?.status === 'EXECUTED' &&
        String(patchJson?.data?.idempotencyKey || '').startsWith(`dex:42161:${simulatedArbTxHash}:`),
      `PATCH /api/trade-intents marks Arbitrum DEX intent EXECUTED with settlement key (Got HTTP ${patchRes.status})`
    );

    const hist2Res = await fetch(`${BASE_URL}/api/trade-intents?limit=5`, { headers: authHeaders });
    const hist2Json: any = await hist2Res.json();
    const matchedExec = (hist2Json?.data?.intents || []).find((it: any) => it?.id === arbIntentId);
    assert(
      matchedExec?.status === 'EXECUTED' &&
        String(matchedExec?.idempotencyKey || '').includes(simulatedArbTxHash),
      `GET /api/trade-intents reflects EXECUTED status & Arbitrum txHash for RecentTradeHistoryPanel Explorer link`
    );

    // 17. Verify Autonomous Terminal Telemetry recentTradeCards reflects settled chainId & explorerUrl (Phase BG)
    const termBgRes = await fetch(`${BASE_URL}/api/agent/terminal-telemetry`, { headers: authHeaders });
    const termBgJson: any = await termBgRes.json();
    const settledTerminalCard = (termBgJson?.data?.recentTradeCards || []).find((c: any) => c?.id === arbIntentId);
    assert(
      termBgRes.status === 200 &&
        settledTerminalCard?.chainId === 42161 &&
        typeof settledTerminalCard?.explorerUrl === 'string' &&
        settledTerminalCard.explorerUrl.startsWith('https://arbiscan.io/tx/') &&
        String(settledTerminalCard?.href || '').includes('chainId=42161'),
      `GET /api/agent/terminal-telemetry enriches settled Arbitrum card with chainId=42161 & explorerUrl (${settledTerminalCard?.explorerUrl})`
    );

    // 18. Verify GET /api/user/activity enriches DEX_SWAP_TX_CONFIRMED with chainId=42161 & explorerUrl (Phase BH)
    const actBhRes = await fetch(`${BASE_URL}/api/user/activity?limit=10`, { headers: authHeaders });
    const actBhJson: any = await actBhRes.json();
    const matchedAct = (actBhJson?.data?.activities || []).find(
      (a: any) => a?.action === 'DEX_SWAP_TX_CONFIRMED' && a?.txHash === simulatedArbTxHash
    );
    assert(
      actBhRes.status === 200 &&
        matchedAct?.chainId === 42161 &&
        typeof matchedAct?.explorerUrl === 'string' &&
        matchedAct.explorerUrl.startsWith('https://arbiscan.io/tx/'),
      `GET /api/user/activity enriches DEX_SWAP_TX_CONFIRMED with chainId=42161 & explorerUrl (${matchedAct?.explorerUrl})`
    );

    // 19. Verify Auto-Pilot tier gate: FREE burner gets eligible=false on GET and HTTP 403 on PUT (Phase BK)
    const apGetRes = await fetch(`${BASE_URL}/api/agent/autopilot`, { headers: authHeaders });
    const apGetJson: any = await apGetRes.json();
    const apPutRes = await fetch(`${BASE_URL}/api/agent/autopilot`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ enabled: true, rail: 'CEX_AUTO', maxOrderUsd: 100 }),
    });
    const apPutJson: any = await apPutRes.json();
    assert(
      apGetRes.status === 200 &&
        apGetJson?.data?.eligible === false &&
        apPutRes.status === 403 &&
        String(apPutJson?.error || '').includes('PLAN_AUTOPILOT_REQUIRED'),
      `GET/PUT /api/agent/autopilot enforces TRADER/AGENT tier gate on FREE burner (GET eligible=false, PUT HTTP ${apPutRes.status})`
    );

    // 20. Verify POST /api/agent/autopilot/simulate enforces HTTP 403 PLAN_AUTOPILOT_REQUIRED on FREE burner (Phase BL)
    const apSimRes = await fetch(`${BASE_URL}/api/agent/autopilot/simulate`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({}),
    });
    const apSimJson: any = await apSimRes.json();
    assert(
      apSimRes.status === 403 &&
        String(apSimJson?.error || '').includes('PLAN_AUTOPILOT_REQUIRED'),
      `POST /api/agent/autopilot/simulate enforces TRADER/AGENT tier gate on FREE burner (Got HTTP ${apSimRes.status})`
    );

    // 21. Verify POST /api/gamefi/quests/complete (daily_checkin) succeeds live without FK violation (Phase CB)
    const gfRes = await fetch(`${BASE_URL}/api/gamefi/quests/complete`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ questId: 'daily_checkin' }),
    });
    const gfJson: any = await gfRes.json();
    assert(
      gfRes.status === 200 &&
        gfJson?.success === true &&
        Number(gfJson?.profile?.xp || 0) >= 25 &&
        Number(gfJson?.creditsGranted || 0) === 5,
      `POST /api/gamefi/quests/complete (daily_checkin) succeeds live with +25 XP & +5 Credits (Got HTTP ${gfRes.status}, xp=${gfJson?.profile?.xp}, err=${gfJson?.error || 'none'})`
    );
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
