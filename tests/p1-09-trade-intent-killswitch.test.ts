import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { NextRequest } from 'next/server';
import { ethers } from 'ethers';
import { POST as appTradeIntentsPost } from '../app/api/trade-intents/route';
import { POST as webAppTradeIntentsPost } from '../apps/web/app/api/trade-intents/route';
import {
  PostgresKillSwitchDbAdapter,
  PostgresBinanceExecutionDbAdapter,
  defaultKillSwitchDbAdapter,
  defaultBinanceExecutionDbAdapter,
  getTradeIntentByIdempotencyKey,
  saveTradeIntent,
  resetDbStateForTesting,
} from '../packages/shared/db-pool';
import {
  BinanceOrderWorker,
  BinanceSpotClient,
  TradeIntentRecord,
} from '../apps/execution-plane/workers/binance-order-worker';
import { BinanceCredentialVault } from '../packages/trading/binance-vault';
import { createSessionToken } from '../packages/auth/session';
import { rateLimiter } from '../packages/auth/rate-limiter';

describe('P1-09: Trade Intent Kill Switch Bypass Remediation & SSOT Invariant Suite', () => {
  const MASTER_KEY_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const TEST_USER_A = 'usr-trader-killswitch-alpha';
  const TEST_USER_B = 'usr-trader-killswitch-beta';
  const walletA = ethers.Wallet.createRandom().address;
  const walletB = ethers.Wallet.createRandom().address;

  const sessionTokenA = createSessionToken({ userId: TEST_USER_A, walletAddress: walletA });
  const sessionTokenB = createSessionToken({ userId: TEST_USER_B, walletAddress: walletB });

  const RAW_API_KEY = 'binance_live_api_key_ks_test_123';
  const RAW_SECRET_KEY = 'binance_live_secret_key_ks_test_456';

  let encryptedApiKey: any;
  let encryptedSecretKey: any;
  let origDbUrl: string | undefined;

  beforeEach(() => {
    origDbUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;

    resetDbStateForTesting();

    // Mock rate limiter to avoid network latency in unit tests
    spyOn(rateLimiter, 'checkRateLimit').mockResolvedValue({
      allowed: true,
      remaining: 100,
      resetMs: 0,
    });

    encryptedApiKey = BinanceCredentialVault.encrypt(RAW_API_KEY, MASTER_KEY_HEX);
    encryptedSecretKey = BinanceCredentialVault.encrypt(RAW_SECRET_KEY, MASTER_KEY_HEX);

    defaultBinanceExecutionDbAdapter.seedCredentials(TEST_USER_A, {
      id: 'cred-ks-1',
      encryptedApiKey: JSON.stringify(encryptedApiKey),
      encryptedSecretKey: JSON.stringify(encryptedSecretKey),
      permissions: { read: true, trade: true, withdraw: false },
      isActive: true,
    });

    defaultBinanceExecutionDbAdapter.seedCredentials(TEST_USER_B, {
      id: 'cred-ks-2',
      encryptedApiKey: JSON.stringify(encryptedApiKey),
      encryptedSecretKey: JSON.stringify(encryptedSecretKey),
      permissions: { read: true, trade: true, withdraw: false },
      isActive: true,
    });
  });

  afterEach(() => {
    if (origDbUrl !== undefined) {
      process.env.DATABASE_URL = origDbUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
  });

  // Helper to create authenticated NextRequest with SIWE capability header
  function createSignedTradeRequest(url: string, body: any, token: string = sessionTokenA): NextRequest {
    return new NextRequest(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  }

  // ==========================================================================
  // 1. API INGESTION NEGATIVE TESTS (Kill Switch Enforced at Ingestion)
  // ==========================================================================
  describe('Group 1: Ingestion Risk Gate with Active Kill Switch', () => {
    it('[API] GLOBAL Kill Switch active -> Rejects trade intent with 400 RISK_REJECTED and persists as REJECTED in SSOT', async () => {
      // 1. Activate Global Kill Switch
      defaultKillSwitchDbAdapter.seedKillSwitch({
        id: 'ks-global-001',
        scope: 'GLOBAL',
        isActive: true,
        reason: 'Market-wide extreme volatility circuit breaker triggered',
        triggeredBy: 'admin-sec-ops',
        triggeredAt: new Date(),
      });

      const idempotencyKey = `idemp-global-blocked-${Date.now()}`;
      const req = createSignedTradeRequest('http://localhost:3000/api/trade-intents', {
        stage: 'LIVE',
        symbol: 'BTC/USDT',
        side: 'BUY',
        type: 'MARKET',
        quantity: 0.1,
        price: 60000,
        idempotencyKey,
      });

      const res = await appTradeIntentsPost(req);
      const json = await res.json();

      // Assert HTTP Response
      expect(res.status).toBe(400);
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('RISK_REJECTED');
      expect(json.error.message).toContain('GLOBAL_KILL_SWITCH_ACTIVE');
      expect(json.data.status).toBe('RISK_REJECTED');
      expect(json.data.decision.isApproved).toBe(false);

      // Assert PostgreSQL SSOT state
      const persisted = await getTradeIntentByIdempotencyKey(idempotencyKey);
      expect(persisted).not.toBeNull();
      expect(persisted?.status).toBe('REJECTED');
      expect(persisted?.riskDecisionReason).toContain('GLOBAL_KILL_SWITCH_ACTIVE');
    });

    it('[API] USER-scoped Kill Switch active -> Rejects targeted user and permits unaffected user', async () => {
      // 1. Activate User Kill Switch for TEST_USER_A
      defaultKillSwitchDbAdapter.seedKillSwitch({
        id: 'ks-user-001',
        scope: 'USER',
        targetId: TEST_USER_A,
        isActive: true,
        reason: 'Account under forensic compliance review',
        triggeredBy: 'compliance-officer-01',
        triggeredAt: new Date(),
      });

      const idempUserA = `idemp-usera-blocked-${Date.now()}`;
      const reqA = createSignedTradeRequest(
        'http://localhost:3000/api/trade-intents',
        {
          stage: 'LIVE',
          symbol: 'ETH/USDT',
          side: 'BUY',
          quantity: 1.0,
          price: 3000,
          idempotencyKey: idempUserA,
        },
        sessionTokenA
      );

      const resA = await appTradeIntentsPost(reqA);
      const jsonA = await resA.json();

      expect(resA.status).toBe(400);
      expect(jsonA.success).toBe(false);
      expect(jsonA.error.message).toContain('USER_KILL_SWITCH_ACTIVE');

      const persistedA = await getTradeIntentByIdempotencyKey(idempUserA);
      expect(persistedA?.status).toBe('REJECTED');

      // 2. Unaffected TEST_USER_B should be APPROVED
      const idempUserB = `idemp-userb-approved-${Date.now()}`;
      const reqB = createSignedTradeRequest(
        'http://localhost:3000/api/trade-intents',
        {
          stage: 'LIVE',
          symbol: 'ETH/USDT',
          side: 'BUY',
          quantity: 1.0,
          price: 3000,
          idempotencyKey: idempUserB,
        },
        sessionTokenB
      );

      const resB = await appTradeIntentsPost(reqB);
      const jsonB = await resB.json();

      expect(resB.status).toBe(200);
      expect(jsonB.success).toBe(true);
      expect(jsonB.data.decision.isApproved).toBe(true);

      const persistedB = await getTradeIntentByIdempotencyKey(idempUserB);
      expect(persistedB?.status).toBe('APPROVED');
    });

    it('[API] TOKEN-scoped Kill Switch active -> Blocks halted symbol (ETH/USDT & ETHUSDT) and permits non-halted symbol', async () => {
      // 1. Activate Token Kill Switch for ETH/USDT
      defaultKillSwitchDbAdapter.seedKillSwitch({
        id: 'ks-token-001',
        scope: 'TOKEN',
        targetId: 'ETH/USDT',
        isActive: true,
        reason: 'Asset bridge anomaly detected on ETH pairs',
        triggeredBy: 'risk-sentinel',
        triggeredAt: new Date(),
      });

      // Target Token Trade Request
      const idempEth = `idemp-eth-blocked-${Date.now()}`;
      const reqEth = createSignedTradeRequest('http://localhost:3000/api/trade-intents', {
        stage: 'LIVE',
        symbol: 'ETH/USDT',
        side: 'BUY',
        quantity: 2.0,
        price: 2500,
        idempotencyKey: idempEth,
      });

      const resEth = await appTradeIntentsPost(reqEth);
      const jsonEth = await resEth.json();

      expect(resEth.status).toBe(400);
      expect(jsonEth.success).toBe(false);
      expect(jsonEth.error.message).toContain('TOKEN_KILL_SWITCH_ACTIVE');

      const persistedEth = await getTradeIntentByIdempotencyKey(idempEth);
      expect(persistedEth?.status).toBe('REJECTED');

      // Non-halted Token Trade Request (SOL/USDT)
      const idempSol = `idemp-sol-approved-${Date.now()}`;
      const reqSol = createSignedTradeRequest('http://localhost:3000/api/trade-intents', {
        stage: 'LIVE',
        symbol: 'SOL/USDT',
        side: 'BUY',
        quantity: 10.0,
        price: 150,
        idempotencyKey: idempSol,
      });

      const resSol = await appTradeIntentsPost(reqSol);
      const jsonSol = await resSol.json();

      expect(resSol.status).toBe(200);
      expect(jsonSol.success).toBe(true);

      const persistedSol = await getTradeIntentByIdempotencyKey(idempSol);
      expect(persistedSol?.status).toBe('APPROVED');
    });

    it('[API Fail-Closed] Kill Switch DB failure -> Returns 503 SERVICE_UNAVAILABLE and creates zero approved intents', async () => {
      // Mock DB failure on getActiveKillSwitches
      const errorSpy = spyOn(defaultKillSwitchDbAdapter, 'getActiveKillSwitches').mockImplementation(() => {
        throw new Error('DATABASE_UNAVAILABLE: Neon connection pool exhausted');
      });

      const idempFail = `idemp-db-fail-${Date.now()}`;
      const req = createSignedTradeRequest('http://localhost:3000/api/trade-intents', {
        stage: 'LIVE',
        symbol: 'BTC/USDT',
        side: 'BUY',
        quantity: 0.1,
        price: 60000,
        idempotencyKey: idempFail,
      });

      const res = await appTradeIntentsPost(req);
      const json = await res.json();

      expect(res.status).toBe(503);
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('SERVICE_UNAVAILABLE');

      // Verify no approved trade intent was persisted
      const persisted = await getTradeIntentByIdempotencyKey(idempFail);
      expect(persisted).toBeNull();

      errorSpy.mockRestore();
    });

    it('[API Alternate Route] /apps/web/app/api/trade-intents strictly enforces kill switches and capability checks', async () => {
      // 1. Activate Global Kill Switch
      defaultKillSwitchDbAdapter.seedKillSwitch({
        id: 'ks-global-web-001',
        scope: 'GLOBAL',
        isActive: true,
        reason: 'Emergency maintenance halt',
        triggeredBy: 'sysadmin',
        triggeredAt: new Date(),
      });

      const idempWeb = `idemp-web-alt-${Date.now()}`;
      const reqWeb = createSignedTradeRequest('http://localhost:3000/api/trade-intents', {
        stage: 'LIVE',
        symbol: 'BNB/USDT',
        side: 'SELL',
        quantity: 1.0,
        price: 550,
        idempotencyKey: idempWeb,
      });

      const resWeb = await webAppTradeIntentsPost(reqWeb);
      const jsonWeb = await resWeb.json();

      expect(resWeb.status).toBe(400);
      expect(jsonWeb.success).toBe(false);
      expect(jsonWeb.error.code).toBe('RISK_REJECTED');
      expect(jsonWeb.error.message).toContain('GLOBAL_KILL_SWITCH_ACTIVE');

      const persistedWeb = await getTradeIntentByIdempotencyKey(idempWeb);
      expect(persistedWeb?.status).toBe('REJECTED');
    });
  });

  // ==========================================================================
  // 2. EXECUTION PLANE PRE-EXECUTION KILL SWITCH ENFORCEMENT
  // ==========================================================================
  describe('Group 2: Binance Worker Pre-Execution Kill Switch Guard', () => {
    it('[WORKER] Pre-existing APPROVED intent is cancelled at execution time if Kill Switch is active (0 Binance API calls)', async () => {
      const mockAdapter = new PostgresBinanceExecutionDbAdapter(null);
      mockAdapter.seedCredentials(TEST_USER_A, {
        id: 'cred-ks-1',
        encryptedApiKey: JSON.stringify(encryptedApiKey),
        encryptedSecretKey: JSON.stringify(encryptedSecretKey),
        permissions: { read: true, trade: true, withdraw: false },
        isActive: true,
      });

      // 1. Seed an APPROVED intent in DB before the kill switch was activated
      const staleApprovedIntent: TradeIntentRecord = {
        id: 'intent-preexisting-approved-001',
        userId: TEST_USER_A,
        stage: 'LIVE',
        symbol: 'BTC/USDT',
        side: 'BUY',
        type: 'MARKET',
        quantity: 0.1,
        price: 60000,
        idempotencyKey: 'idemp-preexisting-001',
        status: 'APPROVED',
        riskDecisionReason: 'Pre-switch approval',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      mockAdapter.seedIntents([staleApprovedIntent]);

      // 2. Activate Global Kill Switch AFTER intent was approved
      defaultKillSwitchDbAdapter.seedKillSwitch({
        id: 'ks-execution-halt-001',
        scope: 'GLOBAL',
        isActive: true,
        reason: 'Execution plane emergency halt by Risk Engine',
        triggeredBy: 'automated-watchdog',
        triggeredAt: new Date(),
      });

      // 3. Track Binance API calls
      let outboundOrdersCount = 0;
      const mockBinanceClient: BinanceSpotClient = {
        newOrder: async () => {
          outboundOrdersCount++;
          return {} as any;
        },
        getOrder: async () => null,
      };

      const worker = new BinanceOrderWorker(
        mockAdapter,
        MASTER_KEY_HEX,
        true,
        () => mockBinanceClient
      );

      // 4. Trigger worker iteration
      const result = await worker.processQueueIteration();
      expect(result.processedCount).toBe(1);

      // 5. Verify zero outbound calls were made to Binance
      expect(outboundOrdersCount).toBe(0);

      // 6. Verify Intent was transitioned to CANCELLED in DB
      const inMemoryAll = mockAdapter.getInMemoryIntents();
      const cancelledIntent = inMemoryAll.find((i) => i.id === staleApprovedIntent.id);
      expect(cancelledIntent?.status).toBe('CANCELLED');
      expect(cancelledIntent?.riskDecisionReason).toContain('KILL_SWITCH_ACTIVE_AT_EXECUTION');

      // 7. Verify Audit Log was recorded
      const auditLogs = mockAdapter.getAuditLogs();
      const cancelAudit = auditLogs.find((a) => a.intentId === staleApprovedIntent.id);
      expect(cancelAudit).toBeDefined();
      expect(cancelAudit?.action).toBe('INTENT_CANCELLED_BY_KILL_SWITCH');
    });

    it('[WORKER] TOKEN kill switch cancels matching intent while non-matching intent executes normally', async () => {
      const mockAdapter = new PostgresBinanceExecutionDbAdapter(null);
      mockAdapter.seedCredentials(TEST_USER_A, {
        id: 'cred-ks-1',
        encryptedApiKey: JSON.stringify(encryptedApiKey),
        encryptedSecretKey: JSON.stringify(encryptedSecretKey),
        permissions: { read: true, trade: true, withdraw: false },
        isActive: true,
      });

      // 1. Seed two APPROVED intents: one for SOL/USDT, one for BTC/USDT
      const solIntent: TradeIntentRecord = {
        id: 'intent-sol-cancel-001',
        userId: TEST_USER_A,
        stage: 'LIVE',
        symbol: 'SOL/USDT',
        side: 'BUY',
        type: 'MARKET',
        quantity: 5.0,
        price: 150,
        idempotencyKey: 'idemp-sol-cancel-001',
        status: 'APPROVED',
        riskDecisionReason: 'Approved',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const btcIntent: TradeIntentRecord = {
        id: 'intent-btc-pass-001',
        userId: TEST_USER_A,
        stage: 'LIVE',
        symbol: 'BTC/USDT',
        side: 'BUY',
        type: 'MARKET',
        quantity: 0.05,
        price: 60000,
        idempotencyKey: 'idemp-btc-pass-001',
        status: 'APPROVED',
        riskDecisionReason: 'Approved',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      mockAdapter.seedIntents([solIntent, btcIntent]);

      // 2. Activate Token Kill Switch ONLY for SOL/USDT
      defaultKillSwitchDbAdapter.seedKillSwitch({
        id: 'ks-sol-token-halt',
        scope: 'TOKEN',
        targetId: 'SOL/USDT',
        isActive: true,
        reason: 'SOL network congestion halt',
        triggeredBy: 'operator',
        triggeredAt: new Date(),
      });

      const dispatchedOrders: any[] = [];
      const mockBinanceClient: BinanceSpotClient = {
        newOrder: async (params) => {
          dispatchedOrders.push(params);
          return {
            symbol: params.symbol,
            orderId: 991122,
            clientOrderId: params.newClientOrderId || '',
            status: 'FILLED',
            executedQty: params.quantity.toString(),
            cummulativeQuoteQty: '3000',
            side: params.side,
            type: params.type,
            transactTime: Date.now(),
          };
        },
        getOrder: async () => null,
      };

      const worker = new BinanceOrderWorker(
        mockAdapter,
        MASTER_KEY_HEX,
        true,
        () => mockBinanceClient
      );

      const result = await worker.processQueueIteration();
      expect(result.processedCount).toBe(2);

      // Verify only 1 order dispatched (BTC), 0 for SOL
      expect(dispatchedOrders.length).toBe(1);
      expect(dispatchedOrders[0].symbol).toBe('BTCUSDT');

      // Verify SOL intent was cancelled and BTC intent was executed
      const inMemory = mockAdapter.getInMemoryIntents();
      const updatedSol = inMemory.find((i) => i.id === solIntent.id);
      const updatedBtc = inMemory.find((i) => i.id === btcIntent.id);

      expect(updatedSol?.status).toBe('CANCELLED');
      expect(updatedSol?.riskDecisionReason).toContain('KILL_SWITCH_ACTIVE_AT_EXECUTION');

      expect(updatedBtc?.status).toBe('EXECUTED');
    });
  });

  // ==========================================================================
  // 3. POSITIVE RESUMPTION TESTS (Normal Operation when Kill Switch is Inactive)
  // ==========================================================================
  describe('Group 3: Normal Operation & Resumption upon Deactivation', () => {
    it('[API -> WORKER E2E] When Kill Switch is inactive, intent is APPROVED at API and EXECUTED at Worker', async () => {
      const mockAdapter = new PostgresBinanceExecutionDbAdapter(null);
      mockAdapter.seedCredentials(TEST_USER_A, {
        id: 'cred-ks-1',
        encryptedApiKey: JSON.stringify(encryptedApiKey),
        encryptedSecretKey: JSON.stringify(encryptedSecretKey),
        permissions: { read: true, trade: true, withdraw: false },
        isActive: true,
      });

      const idempResume = `idemp-resume-${Date.now()}`;
      const req = createSignedTradeRequest('http://localhost:3000/api/trade-intents', {
        stage: 'LIVE',
        symbol: 'BTC/USDT',
        side: 'BUY',
        type: 'MARKET',
        quantity: 0.1,
        price: 60000,
        idempotencyKey: idempResume,
      });

      const res = await appTradeIntentsPost(req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data.decision.isApproved).toBe(true);

      const persisted = await getTradeIntentByIdempotencyKey(idempResume);
      expect(persisted?.status).toBe('APPROVED');

      // Seed it into execution adapter queue for the worker
      mockAdapter.seedIntents([
        {
          id: persisted!.id,
          userId: persisted!.userId,
          stage: persisted!.stage,
          symbol: persisted!.symbol,
          side: persisted!.side,
          type: persisted!.type,
          quantity: Number(persisted!.quantity),
          price: Number(persisted!.price),
          idempotencyKey: persisted!.idempotencyKey,
          status: 'APPROVED',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]);

      let dispatched = false;
      const mockBinanceClient: BinanceSpotClient = {
        newOrder: async (params) => {
          dispatched = true;
          return {
            symbol: params.symbol,
            orderId: 778899,
            clientOrderId: params.newClientOrderId || '',
            status: 'FILLED',
            executedQty: params.quantity.toString(),
            cummulativeQuoteQty: '6000',
            side: params.side,
            type: params.type,
            transactTime: Date.now(),
          };
        },
        getOrder: async () => null,
      };

      const worker = new BinanceOrderWorker(
        mockAdapter,
        MASTER_KEY_HEX,
        true,
        () => mockBinanceClient
      );

      await worker.processQueueIteration();

      expect(dispatched).toBe(true);
      const inMemory = mockAdapter.getInMemoryIntents();
      const executed = inMemory.find((i) => i.id === persisted!.id);
      expect(executed?.status).toBe('EXECUTED');
    });

    it('[RESUMPTION] Deactivating a Kill Switch immediately allows new trade intent creation and execution', async () => {
      // 1. Activate switch
      defaultKillSwitchDbAdapter.seedKillSwitch({
        id: 'ks-temp-halt',
        scope: 'GLOBAL',
        isActive: true,
        reason: 'Temporary network glitch',
        triggeredBy: 'ops',
        triggeredAt: new Date(),
      });

      const idempBlocked = `idemp-blocked-${Date.now()}`;
      const reqBlocked = createSignedTradeRequest('http://localhost:3000/api/trade-intents', {
        stage: 'LIVE',
        symbol: 'BTC/USDT',
        side: 'BUY',
        quantity: 0.1,
        price: 60000,
        idempotencyKey: idempBlocked,
      });

      const resBlocked = await appTradeIntentsPost(reqBlocked);
      expect(resBlocked.status).toBe(400);

      // 2. Deactivate switch
      defaultKillSwitchDbAdapter.clearKillSwitches();

      const idempAllowed = `idemp-allowed-${Date.now()}`;
      const reqAllowed = createSignedTradeRequest('http://localhost:3000/api/trade-intents', {
        stage: 'LIVE',
        symbol: 'BTC/USDT',
        side: 'BUY',
        quantity: 0.1,
        price: 60000,
        idempotencyKey: idempAllowed,
      });

      const resAllowed = await appTradeIntentsPost(reqAllowed);
      const jsonAllowed = await resAllowed.json();

      expect(resAllowed.status).toBe(200);
      expect(jsonAllowed.success).toBe(true);
      expect(jsonAllowed.data.decision.isApproved).toBe(true);

      const persistedAllowed = await getTradeIntentByIdempotencyKey(idempAllowed);
      expect(persistedAllowed?.status).toBe('APPROVED');
    });
  });
});
