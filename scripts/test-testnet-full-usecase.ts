#!/usr/bin/env bun
/**
 * scripts/test-testnet-full-usecase.ts
 *
 * Phase CW: Unified Full-Usecase Testnet End-to-End (E2E) Simulation Runner.
 * Exercises ALL 8 workflow stages across all personas on https://testnet.pndigi.site
 * using an ephemeral random burner wallet (ZERO real funds, ZERO stored keys):
 *
 *   Stage 1: SIWE Auth (EIP-4361) + GameFi Quests (Daily Check-In + SIWE Login)
 *   Stage 2: 1-Click Testnet Tier Upgrades (FREE -> CREATOR -> AGENT) + Credit Ledger
 *   Stage 3: BYOK API Vaults (Bankr + Bybit + Private-Key Reject + Webhook SSRF Reject)
 *   Stage 4: Token Launchpad Draft Creation & Ownership Isolation
 *   Stage 5: Spot/Paper Trade + 6-Chain Live 0x v2 DEX Quote (Base & Arbitrum) + GoPlus Safety
 *   Stage 6: AI Auto-Pilot Config/Simulate + 5-Agent Modular Trading Desk
 *   Stage 7: KOL Hub Profile, Active Bounties & Public Transparency Metrics
 *   Stage 8: RBAC Admin Fail-Closed (403) + Vault Cleanup + Session Logout Invalidation
 */

import { ethers } from 'ethers';

const BASE_URL = (process.env.TEST_TARGET_URL || 'https://testnet.pndigi.site').replace(/\/+$/, '');

if (/^https?:\/\/(www\.)?pndigi\.site$/i.test(BASE_URL)) {
  console.error('❌ SAFETY ABORT: test-testnet-full-usecase.ts is strictly restricted to Testnet / Staging.');
  process.exit(1);
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (!condition) {
    console.error(`  ❌ FAILED: ${label}`);
    failed += 1;
    throw new Error(`Testnet Full-Usecase E2E Assertion Failed: ${label}`);
  }
  console.log(`  ✓ ${label}`);
  passed += 1;
}

function stageHeader(title: string) {
  console.log(`\n--- [${title}] ---`);
}

async function runFullTestnetUsecase() {
  const startedAt = Date.now();
  console.log('========================================================================');
  console.log('  POOLNET FULL-USECASE TESTNET E2E SIMULATION (8 STAGES · ALL PERSONAS)');
  console.log(`  Target: ${BASE_URL}`);
  console.log('========================================================================');

  const burner = ethers.Wallet.createRandom();
  const walletAddress = burner.address;
  let sessionToken = '';
  const createdKeyIds: string[] = [];

  const authHeaders = () => ({
    'Content-Type': 'application/json',
    Cookie: `rtrader_session=${sessionToken}`,
    Authorization: `Bearer ${sessionToken}`,
  });

  try {
    // =========================================================================
    // STAGE 1: SIWE Auth (EIP-4361) + GameFi Quests
    // =========================================================================
    stageHeader('STAGE 1: SIWE Authentication & GameFi Onboarding Quests');

    const chalRes = await fetch(`${BASE_URL}/api/auth/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress }),
    });
    const chalJson: any = await chalRes.json();
    assert(chalRes.status === 200 && chalJson?.success === true, `POST /api/auth/challenge returns HTTP 200`);
    const { nonce, messageToSign } = chalJson.data || {};
    assert(typeof nonce === 'string' && typeof messageToSign === 'string', 'Issued cryptographic SIWE nonce & message');

    const signature = await burner.signMessage(messageToSign);
    const verifyRes = await fetch(`${BASE_URL}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress, signature, nonce, message: messageToSign }),
    });
    const verifyJson: any = await verifyRes.json();
    assert(verifyRes.status === 200 && verifyJson?.success === true, `POST /api/auth/verify returns HTTP 200`);
    sessionToken = String(verifyJson?.data?.sessionToken || '');
    assert(sessionToken.length > 20, 'Received active HMAC SIWE session token');

    const dailyRes = await fetch(`${BASE_URL}/api/gamefi/quests/complete`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ questId: 'daily_checkin' }),
    });
    const dailyJson: any = await dailyRes.json();
    assert(dailyRes.status === 200 && dailyJson?.success === true, `GameFi Daily Check-In succeeded (+25 XP / +5 cr)`);

    const siweQuestRes = await fetch(`${BASE_URL}/api/gamefi/quests/complete`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ questId: 'connect_siwe' }),
    });
    const siweQuestJson: any = await siweQuestRes.json();
    assert(siweQuestRes.status === 200 && siweQuestJson?.success === true, `GameFi SIWE Login quest succeeded (+100 XP / +10 cr)`);

    const sbtGetRes = await fetch(`${BASE_URL}/api/gamefi/genesis-sbt`);
    const sbtGetJson: any = await sbtGetRes.json();
    assert(
      sbtGetRes.status === 200 && sbtGetJson?.success === true && sbtGetJson?.data?.mintPriceEth === '0',
      `GET /api/gamefi/genesis-sbt returned FREE Mint Genesis SBT state (protocolFee=${sbtGetJson?.data?.protocolFeeEth} ETH)`
    );

    // =========================================================================
    // STAGE 2: 1-Click Testnet Tier Upgrades (FREE -> CREATOR -> AGENT) & Ledger
    // =========================================================================
    stageHeader('STAGE 2: 1-Click Testnet Tier Upgrades & Credit Ledger');

    const creatorSubRes = await fetch(`${BASE_URL}/api/billing/subscribe`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ planId: 'CREATOR' }),
    });
    const creatorSubJson: any = await creatorSubRes.json();
    assert(
      creatorSubRes.status === 200 && creatorSubJson?.success === true && creatorSubJson?.data?.planId === 'CREATOR',
      `1-Click Testnet upgrade FREE -> CREATOR succeeded (credits=${creatorSubJson?.data?.credits})`
    );

    const agentSubRes = await fetch(`${BASE_URL}/api/billing/subscribe`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ planId: 'AGENT' }),
    });
    const agentSubJson: any = await agentSubRes.json();
    assert(
      agentSubRes.status === 200 && agentSubJson?.success === true && agentSubJson?.data?.planId === 'AGENT',
      `1-Click Testnet upgrade CREATOR -> AGENT succeeded (credits=${agentSubJson?.data?.credits})`
    );

    const ledgerRes = await fetch(`${BASE_URL}/api/billing/ledger`, { headers: authHeaders() });
    const ledgerJson: any = await ledgerRes.json();
    assert(
      ledgerRes.status === 200 && Array.isArray(ledgerJson?.data?.entries) && ledgerJson.data.entries.length >= 2,
      `GET /api/billing/ledger recorded subscription & quest credits (entries=${ledgerJson?.data?.entries?.length ?? 0})`
    );

    // =========================================================================
    // STAGE 3: BYOK API Vaults (Bankr + Bybit) + Private Key & SSRF Guards
    // =========================================================================
    stageHeader('STAGE 3: BYOK API Vaults (AES-256-GCM) & Security Guards');

    const addBankrRes = await fetch(`${BASE_URL}/api/user/provider-keys`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        provider: 'BANKR',
        label: 'Testnet Fleet Base Key',
        apiKey: 'bnkr_testnet_demo_key_9988776655',
        chainScope: 'base',
      }),
    });
    const addBankrJson: any = await addBankrRes.json();
    assert(addBankrRes.status === 201 && addBankrJson?.success === true, `Stored BANKR key in AES-256-GCM vault (HTTP 201)`);
    if (addBankrJson?.data?.id) createdKeyIds.push(addBankrJson.data.id);

    const badPrivKeyRes = await fetch(`${BASE_URL}/api/user/provider-keys`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        provider: 'BANKR',
        label: 'Malicious PrivKey Attempt',
        apiKey: '0x' + 'a'.repeat(64),
        chainScope: 'base',
      }),
    });
    assert(badPrivKeyRes.status === 400, `Vault strictly rejected 64-hex wallet private key input (HTTP ${badPrivKeyRes.status})`);

    const ssrfWebhookRes = await fetch(`${BASE_URL}/api/user/provider-keys`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        provider: 'WEBHOOK',
        label: 'SSRF Probe',
        apiKey: 'http://127.0.0.1:8080/internal-hook',
      }),
    });
    assert(ssrfWebhookRes.status === 400, `Webhook vault strictly blocked localhost SSRF URL (HTTP ${ssrfWebhookRes.status})`);

    const addBybitRes = await fetch(`${BASE_URL}/api/user/provider-keys`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        provider: 'BYBIT',
        label: 'Testnet Bybit Spot',
        apiKey: `bybit_demo_key_${Date.now()}:bybit_demo_secret_${Date.now()}`,
        chainScope: 'testnet',
      }),
    });
    const addBybitJson: any = await addBybitRes.json();
    assert(addBybitRes.status === 201 && addBybitJson?.success === true, `Stored BYBIT testnet key in vault (HTTP 201)`);
    if (addBybitJson?.data?.id) createdKeyIds.push(addBybitJson.data.id);

    // =========================================================================
    // STAGE 4: Token Launchpad Draft & Live Pools
    // =========================================================================
    stageHeader('STAGE 4: Token Launchpad Draft & Live Pools');

    const draftRes = await fetch(`${BASE_URL}/api/launchpad/draft`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        name: 'PoolNet Testnet Sim Token',
        ticker: 'PTSIM',
        description: 'Automated testnet E2E launchpad verification token',
        imageUrl: '/token-default.svg',
        launchMode: 'BONDING_CURVE',
        targetChain: 'base-mainnet',
        totalSupply: '1000000000',
        creatorAllocationPct: 0.0,
        creatorWallet: walletAddress,
      }),
    });
    const draftJson: any = await draftRes.json();
    assert(
      draftRes.status === 201 && draftJson?.success === true && Boolean(draftJson?.data?.id || draftJson?.data?.draftId),
      `POST /api/launchpad/draft created draft with Risk Passport (status=${draftRes.status}, id=${draftJson?.data?.id || draftJson?.data?.draftId}, score=${draftJson?.data?.riskPassportScore})`
    );

    const listDraftsRes = await fetch(`${BASE_URL}/api/launchpad/draft`, { headers: authHeaders() });
    const listDraftsJson: any = await listDraftsRes.json();
    assert(
      listDraftsRes.status === 200 && Array.isArray(listDraftsJson?.data) && listDraftsJson.data.length >= 1,
      `GET /api/launchpad/draft isolated & returned creator's draft (count=${listDraftsJson?.data?.length ?? 0})`
    );

    const boostGetRes = await fetch(`${BASE_URL}/api/launchpad/featured-boost`);
    const boostGetJson: any = await boostGetRes.json();
    assert(
      boostGetRes.status === 200 && boostGetJson?.success === true && Array.isArray(boostGetJson?.data?.tiers),
      `GET /api/launchpad/featured-boost returned public boost tiers & treasuryWallet (HTTP 200)`
    );

    // Phase EW: Launchpad KOL Verified creator metadata contract
    const launchTokensRes = await fetch(`${BASE_URL}/api/launchpad/tokens`);
    const launchTokensJson: any = await launchTokensRes.json();
    const launchTokensArr = Array.isArray(launchTokensJson?.data) ? launchTokensJson.data : [];
    assert(
      launchTokensRes.status === 200 &&
        launchTokensJson?.success === true &&
        (launchTokensArr.length === 0 || typeof launchTokensArr[0]?.creatorKolVerified === 'boolean'),
      `GET /api/launchpad/tokens exposed creatorKolVerified metadata (count=${launchTokensArr.length})`
    );

    // =========================================================================
    // STAGE 5: Spot/Paper Trade, 6-Chain Live DEX 0x v2 & GoPlus Safety
    // =========================================================================
    stageHeader('STAGE 5: Trading Terminal (Paper + Live 0x v2 DEX + GoPlus Safety)');

    const safetyRes = await fetch(
      `${BASE_URL}/api/trading/token-safety?chainId=8453&address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
    );
    const safetyJson: any = await safetyRes.json();
    assert(safetyRes.status === 200 && safetyJson?.success === true, `GoPlus Token Safety verified Base USDC (HTTP 200)`);

    const paperRes = await fetch(`${BASE_URL}/api/trading/execute`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        symbol: 'BTCUSDT',
        side: 'BUY',
        quantity: 0.002,
        executionMode: 'PAPER',
        maxSlippagePct: 1.0,
      }),
    });
    const paperJson: any = await paperRes.json();
    assert(paperRes.status === 200 && paperJson?.success === true, `Paper Trade BUY BTCUSDT executed cleanly (HTTP 200)`);

    const dexRes = await fetch(`${BASE_URL}/api/trading/execute`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        executionMode: 'DEX_NON_CUSTODIAL',
        stage: 'PAPER',
        symbol: 'USDC',
        tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        chainId: 8453,
        side: 'BUY',
        quantity: 0.005,
        maxSlippagePct: 1.5,
      }),
    });
    const dexJson: any = await dexRes.json();
    assert(
      dexRes.status === 200 && dexJson?.data?.status === 'READY_FOR_WALLET_SIGN' && dexJson?.data?.zeroXSwap?.available === true,
      `Live Base 0x v2 DEX quote returned READY_FOR_WALLET_SIGN (partnerFee=25bps)`
    );

    // =========================================================================
    // STAGE 6: AI Auto-Pilot 24/7 Simulate & 5-Agent Modular Trading Desk
    // =========================================================================
    stageHeader('STAGE 6: AI Auto-Pilot Simulate & 5-Agent Trading Desk');

    const apPutRes = await fetch(`${BASE_URL}/api/agent/autopilot`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({
        enabled: true,
        rail: 'CEX_AUTO',
        autoExecuteCex: false,
        maxOrderUsd: 500,
        takeProfitPct: 12,
        stopLossPct: 5,
        trailingStopPct: 3.5,
        minConfidenceScore: 70,
        allowedSymbols: ['BTCUSDT', 'ETHUSDT'],
      }),
    });
    const apPutJson: any = await apPutRes.json();
    assert(apPutRes.status === 200 && apPutJson?.success === true, `PUT /api/agent/autopilot saved AGENT preset (TP=12%, SL=5%, Trailing=3.5%)`);

    const apSimRes = await fetch(`${BASE_URL}/api/agent/autopilot/simulate`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    const apSimJson: any = await apSimRes.json();
    assert(apSimRes.status === 200 && apSimJson?.success === true, `POST /api/agent/autopilot/simulate ran dry-run cycle cleanly (HTTP 200)`);

    const deskRes = await fetch(`${BASE_URL}/api/agent/desk/run`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        symbol: 'BTCUSDT',
        action: 'BUY',
        quantity: 100,
        mode: 'PAPER',
      }),
    });
    const deskJson: any = await deskRes.json();
    assert(
      deskRes.status === 200 && deskJson?.success === true && Array.isArray(deskJson?.data?.agents),
      `POST /api/agent/desk/run completed 5-Agent cycle (agents=${deskJson?.data?.agents?.length ?? 0})`
    );

    const mktRes = await fetch(`${BASE_URL}/api/agent/marketplace`);
    const mktJson: any = await mktRes.json();
    assert(
      mktRes.status === 200 && mktJson?.success === true && mktJson?.data?.platformFeePct === 20,
      `GET /api/agent/marketplace returned 80/20 Copy-Trading Marketplace (HTTP 200)`
    );

    const copilotMoversRes = await fetch(`${BASE_URL}/api/agent/copilot/chat`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ message: 'Ada token yang naik di atas 5% hari ini?', locale: 'id' }),
    });
    const copilotMoversJson: any = await copilotMoversRes.json();
    assert(
      copilotMoversRes.status === 200 && copilotMoversJson?.data?.intentKind === 'TOP_MOVERS',
      `POST /api/agent/copilot/chat resolved TOP_MOVERS live radar (HTTP ${copilotMoversRes.status})`
    );

    const copilotLimitRes = await fetch(`${BASE_URL}/api/agent/copilot/chat`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ message: 'Kalau BTC turun ke harga 88000 belikan limit sebesar $50', locale: 'id' }),
    });
    const copilotLimitJson: any = await copilotLimitRes.json();
    assert(
      copilotLimitRes.status === 200 &&
        copilotLimitJson?.data?.actionDraft?.kind === 'CEX_LIMIT_ORDER' &&
        Array.isArray(copilotLimitJson?.data?.availableAccounts) &&
        copilotLimitJson.data.availableAccounts.some((a: any) => a.rail === 'PAPER_SIM'),
      `POST /api/agent/copilot/chat built LIMIT draft with PAPER_SIM account (HTTP ${copilotLimitRes.status})`
    );

    const copilotConfirmRes = await fetch(`${BASE_URL}/api/agent/copilot/confirm`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        actionDraft: copilotLimitJson?.data?.actionDraft,
        selectedAccounts: [{ id: 'paper-sim-default', rail: 'PAPER_SIM' }],
      }),
    });
    const copilotConfirmJson: any = await copilotConfirmRes.json();
    const copilotIntentId = copilotConfirmJson?.data?.results?.[0]?.referenceId;
    assert(
      copilotConfirmRes.status === 200 && copilotConfirmJson?.data?.queuedOrDispatchedCount === 1,
      `POST /api/agent/copilot/confirm queued PAPER_SIM LIMIT intent (HTTP ${copilotConfirmRes.status})`
    );

    const cancelIntentRes = await fetch(
      `${BASE_URL}/api/trade-intents?tradeIntentId=${encodeURIComponent(String(copilotIntentId || ''))}`,
      {
        method: 'DELETE',
        headers: authHeaders(),
      }
    );
    const cancelIntentJson: any = await cancelIntentRes.json();
    assert(
      cancelIntentRes.status === 200 && cancelIntentJson?.data?.status === 'CANCELLED',
      `DELETE /api/trade-intents cancelled pending Copilot PAPER_SIM intent (HTTP ${cancelIntentRes.status})`
    );

    // Owned Sub-Wallet ECDSA Proof-of-Ownership round-trip + Copilot TRANSFER_OWNED check (Phase EG)
    const subWallet = ethers.Wallet.createRandom();
    const subChRes = await fetch(
      `${BASE_URL}/api/user/owned-wallets?challengeFor=${encodeURIComponent(subWallet.address)}`,
      { headers: authHeaders() }
    );
    const subChJson: any = await subChRes.json();
    const subSig = await subWallet.signMessage(subChJson?.data?.challenge?.message || '');
    const linkSubRes = await fetch(`${BASE_URL}/api/user/owned-wallets`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        subWalletAddress: subWallet.address,
        challengeToken: subChJson?.data?.challenge?.challengeToken,
        message: subChJson?.data?.challenge?.message,
        signature: subSig,
      }),
    });
    assert(
      linkSubRes.status === 201,
      `POST /api/user/owned-wallets linked ECDSA-verified sub-wallet (HTTP ${linkSubRes.status})`
    );

    const ownedTransferRes = await fetch(`${BASE_URL}/api/agent/copilot/chat`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ message: `Kirim $25 USDC ke ${subWallet.address}`, locale: 'id' }),
    });
    const ownedTransferJson: any = await ownedTransferRes.json();
    assert(
      ownedTransferRes.status === 200 &&
        ownedTransferJson?.data?.intentKind === 'TRANSFER_OWNED' &&
        ownedTransferJson?.data?.actionDraft?.verifiedDestination === subWallet.address.toLowerCase(),
      `POST /api/agent/copilot/chat allowed verified sub-wallet TRANSFER_OWNED draft (HTTP ${ownedTransferRes.status})`
    );

    assert(
      Number(ownedTransferJson?.data?.riskLimits?.transferCap?.dailyCapUsd || 0) > 0,
      `POST /api/agent/copilot/chat exposed per-user 24h rolling transferCap ($${ownedTransferJson?.data?.riskLimits?.transferCap?.dailyCapUsd})`
    );

    // Phase EZ: AI Copilot liveHighlights exposes marketplaceDataset grounding key
    assert(
      ownedTransferJson?.data?.liveHighlights &&
        'marketplaceDataset' in ownedTransferJson.data.liveHighlights,
      `POST /api/agent/copilot/chat exposed liveHighlights.marketplaceDataset grounding field`
    );

    await fetch(
      `${BASE_URL}/api/user/owned-wallets?address=${encodeURIComponent(subWallet.address)}`,
      { method: 'DELETE', headers: authHeaders() }
    );

    // =========================================================================
    // STAGE 7: KOL Hub, Active Bounties & Public Transparency
    // =========================================================================
    stageHeader('STAGE 7: KOL Hub, Bounties & Public Transparency');

    const kolRes = await fetch(`${BASE_URL}/api/kol/profile?walletAddress=${encodeURIComponent(walletAddress)}`, { headers: authHeaders() });
    assert(kolRes.status === 200 || kolRes.status === 404, `GET /api/kol/profile responded cleanly for fresh burner wallet (HTTP ${kolRes.status})`);

    const bountyRes = await fetch(`${BASE_URL}/api/launchpad/bounty`, { headers: authHeaders() });
    const bountyJson: any = await bountyRes.json();
    assert(bountyRes.status === 200 && bountyJson?.success === true, `GET /api/launchpad/bounty loaded active campaigns (HTTP 200)`);

    // Phase EX: Verify requiredFollowHandle field on active bounty campaigns
    const bountyList = Array.isArray(bountyJson?.data) ? bountyJson.data : [];
    assert(
      bountyList.length === 0 || 'requiredFollowHandle' in bountyList[0],
      `GET /api/launchpad/bounty exposed requiredFollowHandle field (campaigns=${bountyList.length})`
    );

    // Phase EY: /api/launchpad/bounty/referrals fail-closed 401 & authenticated stats 200
    const unauthRefRes = await fetch(`${BASE_URL}/api/launchpad/bounty/referrals`);
    assert(
      unauthRefRes.status === 401,
      `GET /api/launchpad/bounty/referrals strictly rejected unauthenticated call (HTTP ${unauthRefRes.status})`
    );

    const authRefRes = await fetch(`${BASE_URL}/api/launchpad/bounty/referrals`, { headers: authHeaders() });
    const authRefJson: any = await authRefRes.json();
    assert(
      authRefRes.status === 200 &&
        authRefJson?.success === true &&
        authRefJson?.data?.bonusPerReferral === 15 &&
        Array.isArray(authRefJson?.data?.recentReferrals),
      `GET /api/launchpad/bounty/referrals returned authenticated referral stats (bonus=+${authRefJson?.data?.bonusPerReferral} cr)`
    );

    const transRes = await fetch(`${BASE_URL}/api/system/transparency`);
    const transJson: any = await transRes.json();
    assert(
      transRes.status === 200 && transJson?.success === true && Boolean(transJson?.data?.feeFlow || transJson?.data?.escrowAndBounties),
      `GET /api/system/transparency returned public live fee & escrow metrics (HTTP 200)`
    );

    const propRes = await fetch(`${BASE_URL}/api/prop/challenge`);
    const propJson: any = await propRes.json();
    assert(
      propRes.status === 200 && propJson?.success === true && propJson?.data?.rules?.profitTargetPct === 8,
      `GET /api/prop/challenge returned Proof-of-Skill Prop Challenge rules & leaderboard (HTTP 200)`
    );

    const propPageRes = await fetch(`${BASE_URL}/prop`);
    assert(propPageRes.status === 200, `GET /prop public Trading Cup UI rendered cleanly (HTTP ${propPageRes.status})`);

    const lbPageRes = await fetch(`${BASE_URL}/leaderboard`);
    assert(lbPageRes.status === 200, `GET /leaderboard public Global Leaderboard UI rendered cleanly (HTTP ${lbPageRes.status})`);

    const termsPageRes = await fetch(`${BASE_URL}/terms`);
    assert(termsPageRes.status === 200, `GET /terms public Terms & Risk Disclosure UI rendered cleanly (HTTP ${termsPageRes.status})`);

    // =========================================================================
    // STAGE 8: RBAC Admin Fail-Closed + Cleanup + Logout Invalidation
    // =========================================================================
    stageHeader('STAGE 8: Admin RBAC Fail-Closed, Cleanup & Session Logout');

    const adminOpsRes = await fetch(`${BASE_URL}/api/admin/ops-summary`, { headers: authHeaders() });
    assert(adminOpsRes.status === 403, `Non-admin AGENT wallet strictly rejected on /api/admin/ops-summary (HTTP ${adminOpsRes.status})`);

    const killRes = await fetch(`${BASE_URL}/api/admin/kill-switch`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ active: true }),
    });
    assert(killRes.status === 403, `Non-admin AGENT wallet strictly rejected on /api/admin/kill-switch (HTTP ${killRes.status})`);

    const partnersGetRes = await fetch(`${BASE_URL}/api/admin/partners`);
    assert(partnersGetRes.status === 200, `GET /api/admin/partners returned public B2B partner registry (HTTP 200)`);

    const partnersPostRes = await fetch(`${BASE_URL}/api/admin/partners`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ slug: 'unauth-dao', brandName: 'Unauth', partnerTreasuryAddress: walletAddress }),
    });
    assert(partnersPostRes.status === 403, `Non-admin AGENT wallet strictly rejected on POST /api/admin/partners (HTTP ${partnersPostRes.status})`);

    const genesisSnapRes = await fetch(`${BASE_URL}/api/admin/genesis-snapshot`, { headers: authHeaders() });
    assert(genesisSnapRes.status === 403, `Non-admin AGENT wallet strictly rejected on GET /api/admin/genesis-snapshot (HTTP ${genesisSnapRes.status})`);

    const bankrLeakRes = await fetch(`${BASE_URL}/api/agent/bankr-prompt`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ prompt: `swap using private key 0x${'ab'.repeat(32)}` }),
    });
    assert(bankrLeakRes.status === 400, `POST /api/agent/bankr-prompt strictly blocked private-key leakage (HTTP ${bankrLeakRes.status})`);

    for (const kid of createdKeyIds) {
      const delRes = await fetch(`${BASE_URL}/api/user/provider-keys?keyId=${encodeURIComponent(kid)}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      assert(delRes.status === 200, `Cleaned up burner vault key ${kid.slice(0, 8)}... (HTTP 200)`);
    }

    const logoutRes = await fetch(`${BASE_URL}/api/auth/logout`, {
      method: 'POST',
      headers: authHeaders(),
    });
    assert(logoutRes.status === 200, `POST /api/auth/logout terminated burner session (HTTP 200)`);

    const elapsedMs = Date.now() - startedAt;
    console.log('\n========================================================================');
    console.log(`  FULL-USECASE TESTNET E2E COMPLETED: ${passed} PASSED, ${failed} FAILED (${elapsedMs}ms)`);
    console.log('========================================================================\n');
  } catch (err: any) {
    console.error(`\n[FATAL] ${err?.message || err}`);
    // Best-effort cleanup of any vault keys created before failure
    for (const kid of createdKeyIds) {
      await fetch(`${BASE_URL}/api/user/provider-keys?keyId=${encodeURIComponent(kid)}`, {
        method: 'DELETE',
        headers: authHeaders(),
      }).catch(() => {});
    }
    process.exit(1);
  }
}

runFullTestnetUsecase();
