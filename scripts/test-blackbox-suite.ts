#!/usr/bin/env bun
/**
 * scripts/test-blackbox-suite.ts
 *
 * Comprehensive Blackbox Testing Suite for RTrader SocialFi Platform:
 * Tests the system strictly as an external client / caller over HTTP:
 * 1. HTTP Security Headers Audit (HSTS, CSP, Frame Options, Sniffing)
 * 2. System Overview & Macro Telemetry APIs
 * 3. Active Token Fleet Query Contract
 * 4. Merkle Bounty Claim Verification & Unregistered Wallet Fallbacks
 * 5. On-Chain Settle API Input Fuzzing & RPC Validation
 * 6. Launchpad Publish API Boundary & Format Validation
 * 7. DEX Graduation API Query & Negative Boundary Tests
 * 8. Middleware RBAC Edge Route Guard Protection
 */

const BASE_URL = process.env.TEST_TARGET_URL || 'https://pndigi.site';

let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  ❌ FAILED: ${message}`);
    failedTests++;
    throw new Error(`Assertion Failed: ${message}`);
  } else {
    console.log(`  ✓ ${message}`);
    passedTests++;
  }
}

async function runBlackboxSuite() {
  console.log('================================================================');
  console.log(`  BLACKBOX TESTING SUITE: LIVE EXTERNAL API & BOUNDARY FUZZING  `);
  console.log(`  Target: ${BASE_URL}`);
  console.log('================================================================\n');

  // ==========================================================================
  // TEST 1: HTTP Security Headers Audit
  // ==========================================================================
  console.log('--- [TEST 1: Edge Security Headers Audit] ---');
  const healthRes = await fetch(`${BASE_URL}/api/system/overview`);
  assert(healthRes.status === 200, `GET /api/system/overview returns HTTP 200 (Got ${healthRes.status})`);

  const headers = healthRes.headers;
  assert(headers.get('x-frame-options') === 'DENY', 'Header X-Frame-Options is DENY (Clickjacking Guard)');
  assert(headers.get('x-content-type-options') === 'nosniff', 'Header X-Content-Type-Options is nosniff (MIME Sniff Guard)');
  assert(headers.has('strict-transport-security'), 'Header Strict-Transport-Security (HSTS) is present');
  assert(headers.has('referrer-policy'), 'Header Referrer-Policy is configured');

  // ==========================================================================
  // TEST 2: System Health & Macro Signals
  // ==========================================================================
  console.log('\n--- [TEST 2: System Health & Macro Telemetry Contracts] ---');
  const healthJson = await healthRes.json();
  assert(healthJson.status === 'ok' || healthJson.success === true, 'System overview payload reports healthy status');

  const macroRes = await fetch(`${BASE_URL}/api/market/macro`);
  assert(macroRes.status === 200, 'GET /api/market/macro returns HTTP 200');
  const macroJson = await macroRes.json();
  assert(macroJson.success === true, 'Macro telemetry returns success: true');
  assert(typeof macroJson.data?.totalDefiTvlUsd === 'number', 'Total Defi TVL is valid number');
  assert(macroJson.data.totalDefiTvlUsd > 0, `Total Defi TVL is positive ($${(macroJson.data.totalDefiTvlUsd / 1e9).toFixed(2)}B)`);
  assert(typeof macroJson.data?.macroSentiment === 'string', 'Macro sentiment signal is present');

  // ==========================================================================
  // TEST 3: Launchpad Fleet Query Contract
  // ==========================================================================
  console.log('\n--- [TEST 3: Launchpad Active Token Fleet Contract] ---');
  const tokensRes = await fetch(`${BASE_URL}/api/launchpad/tokens`);
  assert(tokensRes.status === 200, 'GET /api/launchpad/tokens returns HTTP 200');
  const tokensJson = await tokensRes.json();
  assert(tokensJson.success === true, 'Active tokens response has success: true');
  assert(Array.isArray(tokensJson.data), 'Active tokens payload is an Array');
  assert(tokensJson.data.length > 0, `Active tokens fleet contains live launches (Count: ${tokensJson.data.length})`);

  const firstToken = tokensJson.data[0];
  assert(typeof firstToken.contractAddress === 'string', 'Token contains contractAddress');
  assert(firstToken.contractAddress.startsWith('0x'), 'contractAddress is valid EVM hex address');
  assert(typeof firstToken.chain === 'string', 'Token specifies network chain');
  assert(typeof firstToken.isGraduated === 'boolean', 'Token specifies isGraduated flag');

  // ==========================================================================
  // TEST 4: Bounty Claim & Merkle Proof Query
  // ==========================================================================
  console.log('\n--- [TEST 4: Merkle Bounty Claim Contract & Negative Queries] ---');
  // 4.1 Missing Parameters
  const missingParamRes = await fetch(`${BASE_URL}/api/launchpad/bounty/claim`);
  assert(missingParamRes.status === 400, 'Missing campaignId/wallet returns HTTP 400 Bad Request');

  // 4.2 Unregistered Random Wallet (Must not crash, must return isEligible: false)
  const randomWallet = '0x1234567890123456789012345678901234567890';
  const unregRes = await fetch(
    `${BASE_URL}/api/launchpad/bounty/claim?campaignId=a2be3882-2861-49be-8acc-b4ace0ec993d&walletAddress=${randomWallet}`
  );
  assert(unregRes.status === 200, 'Query with unregistered wallet returns HTTP 200');
  const unregJson = await unregRes.json();
  assert(unregJson.success === true, 'Unregistered wallet query has success: true');
  assert(unregJson.data.isEligible === false, 'Unregistered wallet isEligible is FALSE');
  assert(Array.isArray(unregJson.data.merkleProof), 'merkleProof is an Array');
  assert(unregJson.data.merkleProof.length === 0, 'Unregistered wallet receives empty merkleProof array');

  // ==========================================================================
  // TEST 5: On-Chain Claim Settlement Boundary & Auth Guard
  // ==========================================================================
  console.log('\n--- [TEST 5: On-Chain Settle API Input & Auth Guard] ---');
  // 5.1 Unauthenticated or Malformed JSON payload rejected (401 after C-02 auth hardening, or 400/500)
  const badJsonRes = await fetch(`${BASE_URL}/api/launchpad/bounty/settle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'this is not json{',
  });
  assert(
    badJsonRes.status === 401 || badJsonRes.status === 400 || badJsonRes.status === 500,
    `Unauthenticated/Malformed settle request rejected (Got HTTP ${badJsonRes.status})`
  );

  // 5.2 Empty settle payload rejected (401 without SIWE session or 400)
  const emptyBodyRes = await fetch(`${BASE_URL}/api/launchpad/bounty/settle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert(
    emptyBodyRes.status === 401 || emptyBodyRes.status === 400,
    `Empty settle payload rejected (Got HTTP ${emptyBodyRes.status})`
  );

  // ==========================================================================
  // TEST 6: Launchpad Publish API Boundary & Auth Guard (H-01)
  // ==========================================================================
  console.log('\n--- [TEST 6: Launchpad Publish API Auth Guard (H-01)] ---');
  const pubEmptyRes = await fetch(`${BASE_URL}/api/launchpad/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert(
    pubEmptyRes.status === 401 || pubEmptyRes.status === 400,
    `Unauthenticated publish payload rejected (Got HTTP ${pubEmptyRes.status})`
  );

  // ==========================================================================
  // TEST 7: DEX Graduation API Boundary & Query Fuzzing
  // ==========================================================================
  console.log('\n--- [TEST 7: DEX Graduation API Boundary & Query Tests] ---');
  // 7.1 Valid token graduation query
  const gradQueryRes = await fetch(
    `${BASE_URL}/api/launchpad/graduate?contractAddress=0xa5f832390447b050955d7b734a9a2fa861b4d3ab&chain=robinhood`
  );
  assert(gradQueryRes.status === 200, 'GET /api/launchpad/graduate with valid token returns HTTP 200');
  const gradQueryJson = await gradQueryRes.json();
  assert(gradQueryJson.success === true, 'Graduation query returns success: true');
  assert(gradQueryJson.data.ticker === 'NOIR', 'Resolved correct token ticker');
  assert(typeof gradQueryJson.data.dexDetails?.dexPairAddress === 'string', 'Returns derived/registered dexPairAddress');
  assert(gradQueryJson.data.dexDetails.dexPairAddress.startsWith('0x'), 'dexPairAddress is valid EVM hex');

  // 7.2 Missing query parameter
  const gradMissingRes = await fetch(`${BASE_URL}/api/launchpad/graduate`);
  assert(gradMissingRes.status === 400, 'GET /api/launchpad/graduate without params returns HTTP 400');

  // 7.3 Non-existent token query
  const gradNotFoundRes = await fetch(
    `${BASE_URL}/api/launchpad/graduate?contractAddress=0x0000000000000000000000000000000000000000`
  );
  assert(gradNotFoundRes.status === 404, 'GET /api/launchpad/graduate for unlisted token returns HTTP 404');

  // 7.4 POST Graduation without session rejected (401 C-01 auth guard or 400)
  const gradBadPostRes = await fetch(`${BASE_URL}/api/launchpad/graduate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contractAddress: '0xinvalid' }),
  });
  assert(
    gradBadPostRes.status === 401 || gradBadPostRes.status === 400,
    `POST /api/launchpad/graduate without session rejected (Got HTTP ${gradBadPostRes.status})`
  );

  // ==========================================================================
  // TEST 9: Subscription Plans, Discount Metadata & Protected Billing/Desk APIs
  // ==========================================================================
  console.log('\n--- [TEST 9: Billing Plans, Discounts & 5-Agent Desk Guard] ---');
  const plansRes = await fetch(`${BASE_URL}/api/billing/plans`);
  assert(plansRes.status === 200, 'GET /api/billing/plans returns HTTP 200');
  const plansJson = await plansRes.json();
  assert(plansJson.success === true && Array.isArray(plansJson.data) && plansJson.data.length === 4, 'GET /api/billing/plans returns 4 canonical tiers');
  assert(typeof plansJson.data[0].discountPct === 'number', 'Plan payload includes discountPct field');

  const unauthPlansPost = await fetch(`${BASE_URL}/api/billing/plans`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ planId: 'AGENT', discountPct: 50 }),
  });
  assert(unauthPlansPost.status === 401, 'Unauthenticated POST /api/billing/plans rejected with HTTP 401');

  const unauthDeskPost = await fetch(`${BASE_URL}/api/agent/desk/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'BTCUSDT', action: 'BUY', quantity: 1 }),
  });
  assert(unauthDeskPost.status === 401, 'Unauthenticated POST /api/agent/desk/run rejected with HTTP 401');

  // ==========================================================================
  // TEST 8: Protected Route RBAC / Edge Guard
  // ==========================================================================
  console.log('\n--- [TEST 8: Edge Middleware RBAC Route Protection] ---');
  // Attempt unauthenticated write to protected trade-intents route
  const unauthRes = await fetch(`${BASE_URL}/api/trade-intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'ETH/USDT', quantity: 1 }),
  });
  assert(unauthRes.status === 401, 'Unauthenticated call to /api/trade-intents strictly rejected with HTTP 401');
  const unauthJson = await unauthRes.json();
  assert(unauthJson.success === false, 'Rejection response contains success: false');

  const unauthAuditRes = await fetch(`${BASE_URL}/api/admin/audit-logs`);
  assert(unauthAuditRes.status === 401, 'Unauthenticated GET /api/admin/audit-logs strictly rejected with HTTP 401');

  // ==========================================================================
  // TEST 10: GameFi Profile, Quest & Mint Voucher Auth Guards
  // ==========================================================================
  console.log('\n--- [TEST 10: GameFi Profile, Quest & Mint Voucher Auth Guards] ---');
  const unauthGfProfile = await fetch(`${BASE_URL}/api/gamefi/profile`);
  assert(unauthGfProfile.status === 401, 'Unauthenticated GET /api/gamefi/profile strictly rejected with HTTP 401');

  const unauthGfQuest = await fetch(`${BASE_URL}/api/gamefi/quests/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questId: 'daily_checkin' }),
  });
  assert(unauthGfQuest.status === 401, 'Unauthenticated POST /api/gamefi/quests/complete strictly rejected with HTTP 401');

  const unauthGfVoucher = await fetch(`${BASE_URL}/api/gamefi/nft/mint-voucher`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tier: 'BRONZE' }),
  });
  assert(unauthGfVoucher.status === 401, 'Unauthenticated POST /api/gamefi/nft/mint-voucher strictly rejected with HTTP 401');

  const unauthByokGet = await fetch(`${BASE_URL}/api/user/provider-keys?provider=BANKR`);
  assert(unauthByokGet.status === 401, 'Unauthenticated GET /api/user/provider-keys strictly rejected with HTTP 401');

  const unauthByokPost = await fetch(`${BASE_URL}/api/user/provider-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'Test', apiKey: 'bk_test_1234567890' }),
  });
  assert(unauthByokPost.status === 401, 'Unauthenticated POST /api/user/provider-keys strictly rejected with HTTP 401');

  // -------------------------------------------------------------------------
  // TEST 11: Multi-Account Binance Vault, Risk Policy, Add-Ons & Activity Guards
  // -------------------------------------------------------------------------
  console.log('\n--- [TEST 11: Multi-Account Vaults, Risk Policy, Add-Ons & Activity Guards] ---');
  const unauthBinanceGet = await fetch(`${BASE_URL}/api/user/binance-credentials`);
  assert(unauthBinanceGet.status === 401, 'Unauthenticated GET /api/user/binance-credentials strictly rejected with HTTP 401');

  const unauthBinanceVerify = await fetch(`${BASE_URL}/api/user/binance-credentials/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credentialId: '00000000-0000-0000-0000-000000000001' }),
  });
  assert(unauthBinanceVerify.status === 401, 'Unauthenticated POST /api/user/binance-credentials/verify strictly rejected with HTTP 401');

  const unauthRiskPolicy = await fetch(`${BASE_URL}/api/user/risk-policy`);
  assert(unauthRiskPolicy.status === 401, 'Unauthenticated GET /api/user/risk-policy strictly rejected with HTTP 401');

  const unauthAddons = await fetch(`${BASE_URL}/api/billing/addons`);
  assert(unauthAddons.status === 401, 'Unauthenticated GET /api/billing/addons strictly rejected with HTTP 401');

  const unauthActivity = await fetch(`${BASE_URL}/api/user/activity`);
  assert(unauthActivity.status === 401, 'Unauthenticated GET /api/user/activity strictly rejected with HTTP 401');

  const unauthAgentProfiles = await fetch(`${BASE_URL}/api/agent/profiles`);
  assert(unauthAgentProfiles.status === 401, 'Unauthenticated GET /api/agent/profiles strictly rejected with HTTP 401');

  const unauthProviderVerify = await fetch(`${BASE_URL}/api/user/provider-keys/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyId: 'test', provider: 'ANTHROPIC' }),
  });
  assert(unauthProviderVerify.status === 401, 'Unauthenticated POST /api/user/provider-keys/verify strictly rejected with HTTP 401');

  const unauthVaultSummary = await fetch(`${BASE_URL}/api/user/vault-summary`);
  assert(unauthVaultSummary.status === 401, 'Unauthenticated GET /api/user/vault-summary strictly rejected with HTTP 401');

  const unauthAdminOps = await fetch(`${BASE_URL}/api/admin/ops-summary`);
  assert(unauthAdminOps.status === 401, 'Unauthenticated GET /api/admin/ops-summary strictly rejected with HTTP 401');

  const unauthAgentTerm = await fetch(`${BASE_URL}/api/agent/terminal-telemetry`);
  assert(unauthAgentTerm.status === 401, 'Unauthenticated GET /api/agent/terminal-telemetry strictly rejected with HTTP 401');

  const unauthSessionAllow = await fetch(`${BASE_URL}/api/agent/session-allowance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dailySpendCapUsd: 100 }),
  });
  assert(unauthSessionAllow.status === 401, 'Unauthenticated POST /api/agent/session-allowance strictly rejected with HTTP 401');

  const unauthDualCtrlGet = await fetch(`${BASE_URL}/api/admin/dual-control`);
  assert(unauthDualCtrlGet.status === 401, 'Unauthenticated GET /api/admin/dual-control strictly rejected with HTTP 401');

  const unauthDualCtrlPost = await fetch(`${BASE_URL}/api/admin/dual-control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation: 'PROPOSE', scope: 'GLOBAL' }),
  });
  assert(unauthDualCtrlPost.status === 401, 'Unauthenticated POST /api/admin/dual-control strictly rejected with HTTP 401');

  const unauthAutoPilotGet = await fetch(`${BASE_URL}/api/agent/autopilot`);
  assert(unauthAutoPilotGet.status === 401, 'Unauthenticated GET /api/agent/autopilot strictly rejected with HTTP 401');

  const unauthAutoPilotPut = await fetch(`${BASE_URL}/api/agent/autopilot`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  assert(unauthAutoPilotPut.status === 401, 'Unauthenticated PUT /api/agent/autopilot strictly rejected with HTTP 401');

  const unauthAutoPilotSim = await fetch(`${BASE_URL}/api/agent/autopilot/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert(unauthAutoPilotSim.status === 401, 'Unauthenticated POST /api/agent/autopilot/simulate strictly rejected with HTTP 401');

  const unauthAutoPilotCron = await fetch(`${BASE_URL}/api/cron/autopilot-tick`);
  assert(unauthAutoPilotCron.status === 401, 'Unauthenticated GET /api/cron/autopilot-tick strictly rejected with HTTP 401');

  // -------------------------------------------------------------------------
  // TEST 12: Canonical Frontend Route Integrity & Live Billing Capacity Contract
  // -------------------------------------------------------------------------
  console.log('\n--- [TEST 12: Canonical Frontend Routes & Live Billing Capacities] ---');
  const canonicalPages = ['/', '/launchpad', '/trading', '/agent', '/kol', '/billing'];
  for (const pagePath of canonicalPages) {
    const pageRes = await fetch(`${BASE_URL}${pagePath}`);
    assert(pageRes.status === 200, `Canonical page GET ${pagePath} returns HTTP 200 (Got ${pageRes.status})`);
  }

  const livePlansRes = await fetch(`${BASE_URL}/api/billing/plans`);
  const livePlansJson: any = await livePlansRes.json();
  const livePlans = Array.isArray(livePlansJson?.data) ? livePlansJson.data : [];
  const creatorPlan = livePlans.find((p: any) => p.id === 'CREATOR');
  const agentPlan = livePlans.find((p: any) => p.id === 'AGENT');
  assert(creatorPlan?.capacities?.maxBankrKeys === 15, `Live CREATOR plan exposes maxBankrKeys === 15 (Got ${creatorPlan?.capacities?.maxBankrKeys})`);
  assert(agentPlan?.capacities?.maxBankrKeys === 25, `Live AGENT plan exposes maxBankrKeys === 25 (Got ${agentPlan?.capacities?.maxBankrKeys})`);
  assert(agentPlan?.capacities?.maxBinanceAccounts === 15, `Live AGENT plan exposes maxBinanceAccounts === 15 (Got ${agentPlan?.capacities?.maxBinanceAccounts})`);

  const registryRes = await fetch(`${BASE_URL}/api/providers/registry`);
  assert(registryRes.status === 200, `GET /api/providers/registry returns HTTP 200 (Got ${registryRes.status})`);
  const registryJson: any = await registryRes.json();
  assert(registryJson?.data?.defaultLlm?.primary === 'BYTEPLUS' || registryJson?.data?.defaultLlm?.primary === 'GEMINI', 'Provider registry exposes authoritative defaultLlm primary engine');
  assert(Array.isArray(registryJson?.data?.providers) && registryJson.data.providers.length >= 6, 'Provider registry exposes modular CEX, Launchpad, LLM & Webhook providers');

  // -------------------------------------------------------------------------
  // TEST 13: Public On-Chain Anti-Insider Token Safety Guard (Phase BW)
  // -------------------------------------------------------------------------
  const safetyBadRes = await fetch(`${BASE_URL}/api/trading/token-safety?address=invalid&chainId=8453`);
  assert(safetyBadRes.status === 400, `GET /api/trading/token-safety rejects invalid EVM address with HTTP 400 (Got ${safetyBadRes.status})`);

  const safetyOkRes = await fetch(
    `${BASE_URL}/api/trading/token-safety?address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&chainId=8453`
  );
  assert(safetyOkRes.status === 200, `GET /api/trading/token-safety returns HTTP 200 for Base USDC (Got ${safetyOkRes.status})`);
  const safetyOkJson: any = await safetyOkRes.json();
  assert(safetyOkJson?.success === true, 'GET /api/trading/token-safety responds with structured success=true envelope');

  console.log('\n================================================================');
  console.log(`  🎉 BLACKBOX SUITE COMPLETED: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('================================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runBlackboxSuite()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Blackbox testing error:', err);
    process.exit(1);
  });
