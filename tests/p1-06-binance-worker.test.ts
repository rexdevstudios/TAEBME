import { describe, it, expect, beforeEach, spyOn } from 'bun:test';
import * as crypto from 'crypto';
import {
  BinanceOrderWorker,
  RealBinanceSpotClient,
  BinanceSpotClient,
  TradeIntentRecord,
  BinanceExecutionDbAdapter,
} from '../apps/execution-plane/workers/binance-order-worker';
import { BinanceCredentialVault } from '../packages/trading/binance-vault';
import { PostgresBinanceExecutionDbAdapter, defaultBinanceExecutionDbAdapter, OrderSnapshotStateMachine } from '../packages/shared/db-pool';

describe('P1-06: Binance Order Execution Worker Security & Reliability Suite', () => {
  const MASTER_KEY_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const TEST_USER_ID = 'usr-trader-test-uuid-001';
  const RAW_API_KEY = 'binance_live_api_key_sample_secret_token_123';
  const RAW_SECRET_KEY = 'binance_live_secret_key_super_confidential_456';

  let encryptedApiKey: any;
  let encryptedSecretKey: any;
  let mockAdapter: PostgresBinanceExecutionDbAdapter;

  beforeEach(() => {
    encryptedApiKey = BinanceCredentialVault.encrypt(RAW_API_KEY, MASTER_KEY_HEX);
    encryptedSecretKey = BinanceCredentialVault.encrypt(RAW_SECRET_KEY, MASTER_KEY_HEX);

    mockAdapter = new PostgresBinanceExecutionDbAdapter(null);
    mockAdapter.clearInMemoryState();

    mockAdapter.seedCredentials(TEST_USER_ID, {
      id: 'cred-uuid-1',
      encryptedApiKey: JSON.stringify(encryptedApiKey),
      encryptedSecretKey: JSON.stringify(encryptedSecretKey),
      permissions: { read: true, trade: true, withdraw: false },
      isActive: true,
    });
  });

  // --------------------------------------------------------------------------
  // TEST 1: Real Signed Binance REST Client (HMAC-SHA256 & Query Serialization)
  // --------------------------------------------------------------------------
  it('[UNIT] RealBinanceSpotClient signs orders with valid HMAC-SHA256 and attaches API key header', async () => {
    let capturedUrl = '';
    let capturedHeaders: any = {};
    let capturedMethod = '';

    const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url.toString();
      capturedHeaders = init?.headers || {};
      capturedMethod = init?.method || '';

      return new Response(
        JSON.stringify({
          symbol: 'BTCUSDT',
          orderId: 987654321,
          clientOrderId: 'intent-idemp-001',
          status: 'FILLED',
          executedQty: '0.05000000',
          cummulativeQuoteQty: '3000.00000000',
          side: 'BUY',
          type: 'MARKET',
          transactTime: Date.now(),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const client = new RealBinanceSpotClient({
      apiKey: RAW_API_KEY,
      secretKey: RAW_SECRET_KEY,
      isTestnet: true,
      fetchFn: mockFetch as any,
    });

    const res = await client.newOrder({
      symbol: 'BTC/USDT',
      side: 'BUY',
      type: 'MARKET',
      quantity: 0.05,
      newClientOrderId: 'intent-idemp-001',
    });

    expect(res.orderId).toBe(987654321);
    expect(res.status).toBe('FILLED');
    expect(capturedMethod).toBe('POST');
    expect(capturedHeaders['X-MBX-APIKEY']).toBe(RAW_API_KEY);

    // Verify HMAC signature in URL
    expect(capturedUrl).toContain('https://testnet.binance.vision/api/v3/order?');
    expect(capturedUrl).toContain('symbol=BTCUSDT');
    expect(capturedUrl).toContain('side=BUY');
    expect(capturedUrl).toContain('quantity=0.05');
    expect(capturedUrl).toContain('newClientOrderId=intent-idemp-001');
    expect(capturedUrl).toContain('&signature=');

    // Manually compute expected HMAC signature and verify exact match
    const urlObj = new URL(capturedUrl);
    const signature = urlObj.searchParams.get('signature');
    urlObj.searchParams.delete('signature');
    const queryString = urlObj.search.slice(1);
    const expectedSig = crypto.createHmac('sha256', RAW_SECRET_KEY).update(queryString).digest('hex');
    expect(signature).toBe(expectedSig);
  });

  // --------------------------------------------------------------------------
  // TEST 2: Valid Job Execution (EXECUTING -> FILLED -> EXECUTED in SSOT)
  // --------------------------------------------------------------------------
  it('[UNIT] Scenario 1: Valid job execution transitions through EXECUTING -> FILLED -> EXECUTED and persists order fill', async () => {
    const intent: TradeIntentRecord = {
      id: 'intent-valid-001',
      userId: TEST_USER_ID,
      stage: 'TESTNET',
      symbol: 'ETH/USDT',
      side: 'BUY',
      type: 'LIMIT',
      quantity: 1.5,
      price: 2500,
      maxSlippagePct: 1.0,
      idempotencyKey: 'idemp-eth-001',
      status: 'APPROVED',
    };
    mockAdapter.seedIntent(intent);

    const mockSpotClient: BinanceSpotClient = {
      newOrder: async (params) => {
        expect(params.symbol).toBe('ETHUSDT');
        expect(params.side).toBe('BUY');
        expect(params.quantity).toBe(1.5);
        expect(params.price).toBe(2500);
        return {
          symbol: 'ETHUSDT',
          orderId: 'BNB-MATCH-12345',
          clientOrderId: params.newClientOrderId,
          status: 'FILLED',
          executedQty: 1.5,
          cummulativeQuoteQty: 3750,
        };
      },
      getOrder: async () => null,
    };

    const worker = new BinanceOrderWorker(mockAdapter, MASTER_KEY_HEX, true, () => mockSpotClient);
    const result = await worker.executeSingleIntent(intent);

    expect(result.success).toBe(true);
    expect(result.status).toBe('EXECUTED');
    expect(result.exchangeOrderId).toBe('BNB-MATCH-12345');

    // Verify DB states
    const queue = await mockAdapter.getApprovedIntentsQueue();
    expect(queue.length).toBe(0); // Intent is no longer in APPROVED queue

    const fills = mockAdapter.getOrderFills();
    expect(fills.length).toBe(1);
    expect(fills[0].exchangeOrderId).toBe('BNB-MATCH-12345');
    expect(fills[0].status).toBe('FILLED');
    expect(fills[0].executedQty).toBe(1.5);
    expect(fills[0].cummulativeQuoteQty).toBe(3750);

    const auditLogs = mockAdapter.getAuditLogs();
    const decryptLog = auditLogs.find((l) => l.action === 'BINANCE_CREDENTIAL_DECRYPT');
    const execLog = auditLogs.find((l) => l.action === 'BINANCE_ORDER_EXECUTED');
    expect(decryptLog).toBeDefined();
    expect(execLog).toBeDefined();
  });

  // --------------------------------------------------------------------------
  // TEST 3: Unauthorized / Non-Approved Intent Rejection
  // --------------------------------------------------------------------------
  it('[UNIT] Scenario 2: Worker processQueueIteration strictly ignores non-APPROVED intents', async () => {
    const pendingIntent: TradeIntentRecord = {
      id: 'intent-pending-001',
      userId: TEST_USER_ID,
      stage: 'TESTNET',
      symbol: 'SOL/USDT',
      side: 'BUY',
      type: 'MARKET',
      quantity: 10,
      maxSlippagePct: 1.0,
      idempotencyKey: 'idemp-pending-001',
      status: 'PENDING_RISK',
    };
    const rejectedIntent: TradeIntentRecord = {
      id: 'intent-rejected-002',
      userId: TEST_USER_ID,
      stage: 'TESTNET',
      symbol: 'SOL/USDT',
      side: 'BUY',
      type: 'MARKET',
      quantity: 10,
      maxSlippagePct: 1.0,
      idempotencyKey: 'idemp-rejected-002',
      status: 'REJECTED',
    };

    mockAdapter.seedIntent(pendingIntent);
    mockAdapter.seedIntent(rejectedIntent);

    let clientCalled = false;
    const mockSpotClient: BinanceSpotClient = {
      newOrder: async () => {
        clientCalled = true;
        throw new Error('Should not be called');
      },
      getOrder: async () => null,
    };

    const worker = new BinanceOrderWorker(mockAdapter, MASTER_KEY_HEX, true, () => mockSpotClient);
    const { processedCount } = await worker.processQueueIteration();

    expect(processedCount).toBe(0);
    expect(clientCalled).toBe(false);
    expect(mockAdapter.getOrderFills().length).toBe(0);
  });

  // --------------------------------------------------------------------------
  // TEST 4: Missing Credentials Fails Closed
  // --------------------------------------------------------------------------
  it('[UNIT] Scenario 3: Intent for user without Binance credentials fails closed with BINANCE_CREDS_NOT_FOUND', async () => {
    const unknownUserIntent: TradeIntentRecord = {
      id: 'intent-unregistered-user',
      userId: 'usr-unregistered-no-keys',
      stage: 'TESTNET',
      symbol: 'BNB/USDT',
      side: 'BUY',
      type: 'MARKET',
      quantity: 5,
      maxSlippagePct: 1.0,
      idempotencyKey: 'idemp-no-keys-001',
      status: 'APPROVED',
    };
    mockAdapter.seedIntent(unknownUserIntent);

    const worker = new BinanceOrderWorker(mockAdapter, MASTER_KEY_HEX, true);
    const result = await worker.executeSingleIntent(unknownUserIntent);

    expect(result.success).toBe(false);
    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('BINANCE_CREDS_NOT_FOUND');

    const auditLogs = mockAdapter.getAuditLogs();
    const failLog = auditLogs.find((l) => l.action === 'BINANCE_ORDER_FAILED');
    expect(failLog).toBeDefined();
    expect(failLog?.reason).toContain('BINANCE_CREDS_NOT_FOUND');
  });

  // --------------------------------------------------------------------------
  // TEST 5: Binance API Business Error (e.g. -2010 Insufficient Balance)
  // --------------------------------------------------------------------------
  it('[UNIT] Scenario 4: Binance API rejection (e.g. -2010 Insufficient Balance) sets status to FAILED and records audit log', async () => {
    const intent: TradeIntentRecord = {
      id: 'intent-insufficient-funds',
      userId: TEST_USER_ID,
      stage: 'TESTNET',
      symbol: 'BTC/USDT',
      side: 'BUY',
      type: 'MARKET',
      quantity: 100,
      maxSlippagePct: 1.0,
      idempotencyKey: 'idemp-insufficient-001',
      status: 'APPROVED',
    };
    mockAdapter.seedIntent(intent);

    const mockSpotClient: BinanceSpotClient = {
      newOrder: async () => {
        const err = new Error('Binance API Error (-2010): Account has insufficient balance for requested action.');
        err.name = 'BinanceApiError';
        throw err;
      },
      getOrder: async () => null,
    };

    const worker = new BinanceOrderWorker(mockAdapter, MASTER_KEY_HEX, true, () => mockSpotClient);
    const result = await worker.executeSingleIntent(intent);

    expect(result.success).toBe(false);
    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('Binance API Error (-2010)');

    const auditLogs = mockAdapter.getAuditLogs();
    const failLog = auditLogs.find((l) => l.action === 'BINANCE_ORDER_FAILED');
    expect(failLog).toBeDefined();
    expect(failLog?.reason).toContain('-2010');
  });

  // --------------------------------------------------------------------------
  // TEST 6: Network Timeout / Server Error with Idempotent Query Reconciliation
  // --------------------------------------------------------------------------
  it('[UNIT] Scenario 5: Network timeout on order submission triggers idempotent getOrder reconciliation and marks EXECUTED when filled on exchange', async () => {
    const intent: TradeIntentRecord = {
      id: 'intent-timeout-reconcile',
      userId: TEST_USER_ID,
      stage: 'TESTNET',
      symbol: 'AVAX/USDT',
      side: 'SELL',
      type: 'MARKET',
      quantity: 50,
      maxSlippagePct: 1.0,
      idempotencyKey: 'idemp-timeout-rec-001',
      status: 'APPROVED',
    };
    mockAdapter.seedIntent(intent);

    let getOrderCalled = false;
    const mockSpotClient: BinanceSpotClient = {
      newOrder: async () => {
        const netErr = new Error('ETIMEDOUT: Connection timed out while sending POST /api/v3/order');
        netErr.name = 'BinanceNetworkError';
        throw netErr;
      },
      getOrder: async (symbol, origClientOrderId) => {
        getOrderCalled = true;
        expect(symbol).toBe('AVAXUSDT');
        expect(origClientOrderId).toBe('idemp-timeout-rec-001');

        // Order actually reached exchange and was filled!
        return {
          symbol: 'AVAXUSDT',
          orderId: 7788990011,
          clientOrderId: origClientOrderId,
          status: 'FILLED',
          executedQty: 50,
          cummulativeQuoteQty: 1500,
        };
      },
    };

    const worker = new BinanceOrderWorker(mockAdapter, MASTER_KEY_HEX, true, () => mockSpotClient);
    const result = await worker.executeSingleIntent(intent);

    expect(getOrderCalled).toBe(true);
    expect(result.success).toBe(true);
    expect(result.status).toBe('EXECUTED');
    expect(result.exchangeOrderId).toBe('7788990011');

    const fills = mockAdapter.getOrderFills();
    expect(fills.length).toBe(1);
    expect(fills[0].exchangeOrderId).toBe('7788990011');
    expect(fills[0].status).toBe('FILLED');

    const auditLogs = mockAdapter.getAuditLogs();
    const reconcileLog = auditLogs.find((l) => l.action === 'BINANCE_ORDER_RECONCILED');
    expect(reconcileLog).toBeDefined();
    expect(reconcileLog?.reason).toContain('7788990011');
  });

  // --------------------------------------------------------------------------
  // TEST 7: Network Timeout with Order Not Found on Exchange (Ambiguous - Retains EXECUTING)
  // --------------------------------------------------------------------------
  it('[UNIT] Scenario 5b: Network timeout on order submission with getOrder returning null retains EXECUTING safely without premature FAILED or duplicate fill', async () => {
    const intent: TradeIntentRecord = {
      id: 'intent-timeout-not-found',
      userId: TEST_USER_ID,
      stage: 'TESTNET',
      symbol: 'LINK/USDT',
      side: 'BUY',
      type: 'LIMIT',
      quantity: 20,
      price: 15,
      maxSlippagePct: 1.0,
      idempotencyKey: 'idemp-timeout-nf-001',
      status: 'APPROVED',
    };
    mockAdapter.seedIntent(intent);

    const mockSpotClient: BinanceSpotClient = {
      newOrder: async () => {
        const netErr = new Error('ECONNRESET: Socket closed prematurely');
        netErr.name = 'BinanceNetworkError';
        throw netErr;
      },
      getOrder: async () => {
        // Order never made it to the matching engine
        return null;
      },
    };

    const worker = new BinanceOrderWorker(mockAdapter, MASTER_KEY_HEX, true, () => mockSpotClient);
    const result = await worker.executeSingleIntent(intent);

    expect(result.success).toBe(false);
    expect(result.status).toBe('EXECUTING');
    expect(mockAdapter.getOrderFills().length).toBe(0);
    const ambigLog = mockAdapter.getAuditLogs().find((l) => l.action === 'BINANCE_ORDER_SUBMISSION_AMBIGUOUS');
    expect(ambigLog).toBeDefined();
  });

  // --------------------------------------------------------------------------
  // TEST 8: Strict Prohibition of Withdrawal Permissions (enableWithdrawals)
  // --------------------------------------------------------------------------
  it('[UNIT] Scenario 8: Binance key with withdrawal permissions (enableWithdrawals = true) is strictly rejected', async () => {
    const dangerousUserId = 'usr-hacker-with-withdrawal-key';
    mockAdapter.seedCredentials(dangerousUserId, {
      id: 'cred-dangerous-uuid',
      encryptedApiKey: JSON.stringify(encryptedApiKey),
      encryptedSecretKey: JSON.stringify(encryptedSecretKey),
      permissions: { read: true, trade: true, withdraw: true }, // WITHDRAWAL ENABLED!
      isActive: true,
    });

    const intent: TradeIntentRecord = {
      id: 'intent-dangerous-withdraw',
      userId: dangerousUserId,
      stage: 'TESTNET',
      symbol: 'ETH/USDT',
      side: 'BUY',
      type: 'MARKET',
      quantity: 1.0,
      maxSlippagePct: 1.0,
      idempotencyKey: 'idemp-dangerous-001',
      status: 'APPROVED',
    };
    mockAdapter.seedIntent(intent);

    let clientInvoked = false;
    const mockSpotClient: BinanceSpotClient = {
      newOrder: async () => {
        clientInvoked = true;
        throw new Error('Should NEVER be reached');
      },
      getOrder: async () => null,
    };

    const worker = new BinanceOrderWorker(mockAdapter, MASTER_KEY_HEX, true, () => mockSpotClient);
    const result = await worker.executeSingleIntent(intent);

    expect(result.success).toBe(false);
    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('WITHDRAWAL_PERMISSION_PROHIBITED');
    expect(clientInvoked).toBe(false);

    const auditLogs = mockAdapter.getAuditLogs();
    const securityRejectionLog = auditLogs.find((l) => l.action === 'BINANCE_SECURITY_REJECTION');
    expect(securityRejectionLog).toBeDefined();
    expect(securityRejectionLog?.reason).toContain('WITHDRAWAL_PERMISSION_PROHIBITED');
  });

  // --------------------------------------------------------------------------
  // TEST 9: Sensitive Credentials Redaction in Logs and Errors
  // --------------------------------------------------------------------------
  it('[UNIT] Scenario 9: Sensitive API Keys, Secret Keys, and Signatures are NEVER leaked in logs, audit records, or errors', async () => {
    const intent: TradeIntentRecord = {
      id: 'intent-redaction-check',
      userId: TEST_USER_ID,
      stage: 'TESTNET',
      symbol: 'DOGE/USDT',
      side: 'BUY',
      type: 'MARKET',
      quantity: 1000,
      maxSlippagePct: 1.0,
      idempotencyKey: 'idemp-redaction-001',
      status: 'APPROVED',
    };
    mockAdapter.seedIntent(intent);

    const mockSpotClient: BinanceSpotClient = {
      newOrder: async () => {
        // Simulate a raw third-party error containing key details in message
        throw new Error(`Connection failed with key ${RAW_API_KEY} and signature abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890`);
      },
      getOrder: async () => null,
    };

    const worker = new BinanceOrderWorker(mockAdapter, MASTER_KEY_HEX, true, () => mockSpotClient);
    const result = await worker.executeSingleIntent(intent);

    expect(result.success).toBe(false);
    expect(result.error).not.toContain(RAW_API_KEY);
    expect(result.error).not.toContain(RAW_SECRET_KEY);
    expect(result.error).not.toContain('abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890');

    // Audit logs must not leak secrets
    const auditLogs = mockAdapter.getAuditLogs();
    for (const log of auditLogs) {
      expect(log.reason).not.toContain(RAW_API_KEY);
      expect(log.reason).not.toContain(RAW_SECRET_KEY);
    }
  });

  // --------------------------------------------------------------------------
  // TEST 10: In-Flight Concurrency Guard & Duplicate Job Handling
  // --------------------------------------------------------------------------
  it('[UNIT] Scenario 6: Concurrency guard prevents duplicate processing of the same intent', async () => {
    const intent: TradeIntentRecord = {
      id: 'intent-duplicate-check',
      userId: TEST_USER_ID,
      stage: 'TESTNET',
      symbol: 'BTC/USDT',
      side: 'BUY',
      type: 'MARKET',
      quantity: 0.1,
      maxSlippagePct: 1.0,
      idempotencyKey: 'idemp-dup-001',
      status: 'APPROVED',
    };
    mockAdapter.seedIntent(intent);

    let executionCount = 0;
    const mockSpotClient: BinanceSpotClient = {
      newOrder: async (p) => {
        executionCount++;
        await new Promise((r) => setTimeout(r, 20));
        return {
          symbol: 'BTCUSDT',
          orderId: 556677,
          clientOrderId: p.newClientOrderId,
          status: 'FILLED',
          executedQty: 0.1,
          cummulativeQuoteQty: 6000,
        };
      },
      getOrder: async () => null,
    };

    const worker = new BinanceOrderWorker(mockAdapter, MASTER_KEY_HEX, true, () => mockSpotClient);

    // Run two processQueueIteration in parallel
    const [res1, res2] = await Promise.all([
      worker.processQueueIteration(),
      worker.processQueueIteration(),
    ]);

    expect(executionCount).toBe(1); // Executed exactly once!
    expect(res1.processedCount + res2.processedCount).toBe(1);
  });

  // --------------------------------------------------------------------------
  // TEST 11: Worker Restart & Queue Recovery Semantics
  // --------------------------------------------------------------------------
  it('[UNIT] Scenario 11: Worker restart successfully picks up unexecuted APPROVED intents from queue', async () => {
    const intent1: TradeIntentRecord = {
      id: 'intent-recovery-1',
      userId: TEST_USER_ID,
      stage: 'TESTNET',
      symbol: 'UNI/USDT',
      side: 'BUY',
      type: 'MARKET',
      quantity: 15,
      maxSlippagePct: 1.0,
      idempotencyKey: 'idemp-rec-001',
      status: 'APPROVED',
    };
    const intent2: TradeIntentRecord = {
      id: 'intent-recovery-2',
      userId: TEST_USER_ID,
      stage: 'TESTNET',
      symbol: 'AAVE/USDT',
      side: 'BUY',
      type: 'MARKET',
      quantity: 2,
      maxSlippagePct: 1.0,
      idempotencyKey: 'idemp-rec-002',
      status: 'APPROVED',
    };

    mockAdapter.seedIntent(intent1);
    mockAdapter.seedIntent(intent2);

    const executedOrderIds: string[] = [];
    const mockSpotClient: BinanceSpotClient = {
      newOrder: async (p) => {
        const orderId = `BNB-REC-${executedOrderIds.length + 1}`;
        executedOrderIds.push(orderId);
        return {
          symbol: p.symbol,
          orderId,
          clientOrderId: p.newClientOrderId,
          status: 'FILLED',
          executedQty: p.quantity,
          cummulativeQuoteQty: p.quantity * 10,
        };
      },
      getOrder: async () => null,
    };

    // First worker instance starts and stops after processing intent 1
    const worker1 = new BinanceOrderWorker(mockAdapter, MASTER_KEY_HEX, true, () => mockSpotClient);
    await worker1.executeSingleIntent(intent1);

    expect(executedOrderIds.length).toBe(1);

    // Second worker starts and processes remaining queue
    const worker2 = new BinanceOrderWorker(mockAdapter, MASTER_KEY_HEX, true, () => mockSpotClient);
    const { processedCount } = await worker2.processQueueIteration();

    expect(processedCount).toBe(1); // Only intent2 was pending in approved queue
    expect(executedOrderIds.length).toBe(2);

    const fills = mockAdapter.getOrderFills();
    expect(fills.length).toBe(2);
  });

  // --------------------------------------------------------------------------
  // GROUP A: POSTGRES FAIL-CLOSED VERIFICATION (NO SILENT MEMORY FALLBACK)
  // --------------------------------------------------------------------------
  describe('Group A: PostgreSQL Fail-Closed Enforcement', () => {
    const errorPool = {
      query: async () => {
        throw new Error('Neon DB connection timeout: 504 Gateway Timeout');
      },
    } as any;

    it('[UNIT] getApprovedIntentsQueue throws error when PostgreSQL fails (no silent memory fallback)', async () => {
      const adapter = new PostgresBinanceExecutionDbAdapter(errorPool);
      // Seed in-memory map to prove that fallback is NOT returned
      adapter.seedIntent({
        id: crypto.randomUUID(),
        userId: crypto.randomUUID(),
        stage: 'TESTNET',
        symbol: 'BTC/USDT',
        side: 'BUY',
        type: 'MARKET',
        quantity: 1,
        maxSlippagePct: 1,
        idempotencyKey: 'idemp-fail-closed-1',
        status: 'APPROVED',
      });

      let threw = false;
      try {
        await adapter.getApprovedIntentsQueue();
      } catch (err: any) {
        threw = true;
        expect(err.message).toContain('Neon DB connection timeout');
      }
      expect(threw).toBe(true);
    });

    it('[UNIT] claimIntentAtomic throws error when PostgreSQL fails (fail-closed)', async () => {
      const adapter = new PostgresBinanceExecutionDbAdapter(errorPool);
      let threw = false;
      try {
        await adapter.claimIntentAtomic(crypto.randomUUID());
      } catch (err: any) {
        threw = true;
        expect(err.message).toContain('Neon DB connection timeout');
      }
      expect(threw).toBe(true);
    });

    it('[UNIT] updateIntentStatus throws error when PostgreSQL fails (fail-closed)', async () => {
      const adapter = new PostgresBinanceExecutionDbAdapter(errorPool);
      let threw = false;
      try {
        await adapter.updateIntentStatus(crypto.randomUUID(), 'EXECUTING');
      } catch (err: any) {
        threw = true;
        expect(err.message).toContain('Neon DB connection timeout');
      }
      expect(threw).toBe(true);
    });

    it('[UNIT] getBinanceCredentials throws error when PostgreSQL fails (fail-closed)', async () => {
      const adapter = new PostgresBinanceExecutionDbAdapter(errorPool);
      let threw = false;
      try {
        await adapter.getBinanceCredentials(crypto.randomUUID());
      } catch (err: any) {
        threw = true;
        expect(err.message).toContain('Neon DB connection timeout');
      }
      expect(threw).toBe(true);
    });

    it('[UNIT] recordOrderFill throws error when PostgreSQL fails (fail-closed)', async () => {
      const adapter = new PostgresBinanceExecutionDbAdapter(errorPool);
      let threw = false;
      try {
        await adapter.recordOrderFill({
          intentId: crypto.randomUUID(),
          exchangeOrderId: 'BNB-FAIL-1',
          symbol: 'ETHUSDT',
          status: 'FILLED',
          executedQty: 1,
          cummulativeQuoteQty: 2500,
        });
      } catch (err: any) {
        threw = true;
        expect(err.message).toContain('Neon DB connection timeout');
      }
      expect(threw).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // GROUP B: ATOMIC COMPARE-AND-SWAP (CAS) & MULTI-WORKER CONCURRENCY
  // --------------------------------------------------------------------------
  describe('Group B: Atomic CAS Intent Claim', () => {
    it('[UNIT] Worker A and Worker B racing on identical intent: exactly one claim succeeds and exactly one outbound Binance order is submitted', async () => {
      const sharedAdapter = new PostgresBinanceExecutionDbAdapter(null);
      const testIntent: TradeIntentRecord = {
        id: crypto.randomUUID(),
        userId: TEST_USER_ID,
        stage: 'TESTNET',
        symbol: 'BTC/USDT',
        side: 'BUY',
        type: 'MARKET',
        quantity: 0.25,
        maxSlippagePct: 1.0,
        idempotencyKey: 'idemp-cas-race-001',
        status: 'APPROVED',
      };
      sharedAdapter.seedIntent(testIntent);
      sharedAdapter.seedCredentials(TEST_USER_ID, {
        id: 'cred-uuid-1',
        encryptedApiKey: JSON.stringify(encryptedApiKey),
        encryptedSecretKey: JSON.stringify(encryptedSecretKey),
        permissions: { read: true, trade: true, withdraw: false },
        isActive: true,
      });

      let outboundCallsCount = 0;
      const mockSpotClient: BinanceSpotClient = {
        newOrder: async (p) => {
          outboundCallsCount++;
          await new Promise((r) => setTimeout(r, 20)); // Simulate network latency
          return {
            symbol: p.symbol,
            orderId: 99887766,
            clientOrderId: p.newClientOrderId,
            status: 'FILLED',
            executedQty: p.quantity,
            cummulativeQuoteQty: p.quantity * 60000,
          };
        },
        getOrder: async () => null,
      };

      const workerA = new BinanceOrderWorker(sharedAdapter, MASTER_KEY_HEX, true, () => mockSpotClient);
      const workerB = new BinanceOrderWorker(sharedAdapter, MASTER_KEY_HEX, true, () => mockSpotClient);

      // Concurrent invocation of processQueueIteration on both workers
      const [resA, resB] = await Promise.all([
        workerA.processQueueIteration(),
        workerB.processQueueIteration(),
      ]);

      expect(outboundCallsCount).toBe(1); // EXACTLY ONE outbound Binance call!
      expect(resA.processedCount + resB.processedCount).toBe(1);

      const fills = sharedAdapter.getOrderFills();
      expect(fills.length).toBe(1);
      expect(fills[0].exchangeOrderId).toBe('99887766');
    });

    it('[UNIT] Direct executeSingleIntent rejects already-claimed intent with CLAIM_REJECTED and zero Binance API calls', async () => {
      const sharedAdapter = new PostgresBinanceExecutionDbAdapter(null);
      const claimedIntent: TradeIntentRecord = {
        id: crypto.randomUUID(),
        userId: TEST_USER_ID,
        stage: 'TESTNET',
        symbol: 'ETH/USDT',
        side: 'BUY',
        type: 'LIMIT',
        quantity: 1,
        price: 2600,
        maxSlippagePct: 1.0,
        idempotencyKey: 'idemp-already-exec-001',
        status: 'EXECUTING', // ALREADY IN EXECUTING STATUS
      };
      sharedAdapter.seedIntent(claimedIntent);

      let clientCalled = false;
      const mockSpotClient: BinanceSpotClient = {
        newOrder: async () => {
          clientCalled = true;
          throw new Error('Should NEVER be called for unclaimable intent');
        },
        getOrder: async () => null,
      };

      const worker = new BinanceOrderWorker(sharedAdapter, MASTER_KEY_HEX, true, () => mockSpotClient);
      const res = await worker.executeSingleIntent(claimedIntent);

      expect(res.success).toBe(false);
      expect(res.status).toBe('CLAIM_REJECTED');
      expect(clientCalled).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // GROUP C: STALE EXECUTING CRASH RECOVERY
  // --------------------------------------------------------------------------
  describe('Group C: Stale EXECUTING Crash Recovery', () => {
    it('[UNIT] Stale EXECUTING intent filled on exchange is recovered to EXECUTED with zero newOrder calls', async () => {
      const recoveryAdapter = new PostgresBinanceExecutionDbAdapter(null);
      const staleTimestamp = new Date(Date.now() - 300000).toISOString(); // 5 minutes ago

      const staleIntent: TradeIntentRecord = {
        id: crypto.randomUUID(),
        userId: TEST_USER_ID,
        stage: 'TESTNET',
        symbol: 'SOL/USDT',
        side: 'BUY',
        type: 'MARKET',
        quantity: 20,
        maxSlippagePct: 1.0,
        idempotencyKey: 'idemp-stale-filled-001',
        status: 'EXECUTING',
        createdAt: staleTimestamp,
      };

      recoveryAdapter.seedIntent(staleIntent);
      recoveryAdapter.seedCredentials(TEST_USER_ID, {
        id: 'cred-uuid-1',
        encryptedApiKey: JSON.stringify(encryptedApiKey),
        encryptedSecretKey: JSON.stringify(encryptedSecretKey),
        permissions: { read: true, trade: true, withdraw: false },
        isActive: true,
      });

      let getOrderCalled = false;
      let newOrderCalled = false;

      const mockSpotClient: BinanceSpotClient = {
        newOrder: async () => {
          newOrderCalled = true;
          throw new Error('CRITICAL VIOLATION: newOrder must NEVER be called during stale crash recovery!');
        },
        getOrder: async (symbol, origClientOrderId) => {
          getOrderCalled = true;
          expect(symbol).toBe('SOLUSDT');
          expect(origClientOrderId).toBe('idemp-stale-filled-001');

          return {
            symbol: 'SOLUSDT',
            orderId: 8877665544,
            clientOrderId: origClientOrderId,
            status: 'FILLED',
            executedQty: 20,
            cummulativeQuoteQty: 3000,
          };
        },
      };

      const worker = new BinanceOrderWorker(recoveryAdapter, MASTER_KEY_HEX, true, () => mockSpotClient);
      const sweepRes = await worker.reconcileStaleExecutingIntents(120000); // 2 min threshold

      expect(newOrderCalled).toBe(false);
      expect(getOrderCalled).toBe(true);
      expect(sweepRes.reconciledCount).toBe(1);

      const fills = recoveryAdapter.getOrderFills();
      expect(fills.length).toBe(1);
      expect(fills[0].exchangeOrderId).toBe('8877665544');
      expect(fills[0].status).toBe('FILLED');

      const auditLogs = recoveryAdapter.getAuditLogs();
      const recLog = auditLogs.find((l) => l.action === 'BINANCE_ORDER_RECONCILED');
      expect(recLog).toBeDefined();
      expect(recLog?.reason).toContain('8877665544');
    });

    it('[UNIT] Stale EXECUTING intent not found on exchange (404 / -2013) safely transitions to FAILED with zero newOrder calls', async () => {
      const recoveryAdapter = new PostgresBinanceExecutionDbAdapter(null);
      const staleTimestamp = new Date(Date.now() - 300000).toISOString();

      const staleIntent: TradeIntentRecord = {
        id: crypto.randomUUID(),
        userId: TEST_USER_ID,
        stage: 'TESTNET',
        symbol: 'ADA/USDT',
        side: 'BUY',
        type: 'LIMIT',
        quantity: 500,
        price: 0.5,
        maxSlippagePct: 1.0,
        idempotencyKey: 'idemp-stale-notfound-001',
        status: 'EXECUTING',
        createdAt: staleTimestamp,
      };

      recoveryAdapter.seedIntent(staleIntent);
      recoveryAdapter.seedCredentials(TEST_USER_ID, {
        id: 'cred-uuid-1',
        encryptedApiKey: JSON.stringify(encryptedApiKey),
        encryptedSecretKey: JSON.stringify(encryptedSecretKey),
        permissions: { read: true, trade: true, withdraw: false },
        isActive: true,
      });

      let getOrderCalled = false;
      let newOrderCalled = false;

      const mockSpotClient: BinanceSpotClient = {
        newOrder: async () => {
          newOrderCalled = true;
          throw new Error('CRITICAL VIOLATION: newOrder called during recovery!');
        },
        getOrder: async () => {
          getOrderCalled = true;
          return null; // Confirmed order does not exist on exchange
        },
      };

      const worker = new BinanceOrderWorker(recoveryAdapter, MASTER_KEY_HEX, true, () => mockSpotClient);
      const sweepRes = await worker.reconcileStaleExecutingIntents(120000);

      expect(newOrderCalled).toBe(false);
      expect(getOrderCalled).toBe(true);
      expect(sweepRes.reconciledCount).toBe(1);
      expect(recoveryAdapter.getOrderFills().length).toBe(0);

      const auditLogs = recoveryAdapter.getAuditLogs();
      const failLog = auditLogs.find((l) => l.action === 'BINANCE_ORDER_FAILED');
      expect(failLog).toBeDefined();
      expect(failLog?.reason).toContain('was never registered on exchange');
    });

    it('[UNIT] Stale EXECUTING intent encountering network timeout during query remains non-terminal (EXECUTING) without newOrder submission', async () => {
      const recoveryAdapter = new PostgresBinanceExecutionDbAdapter(null);
      const staleTimestamp = new Date(Date.now() - 300000).toISOString();

      const staleIntent: TradeIntentRecord = {
        id: crypto.randomUUID(),
        userId: TEST_USER_ID,
        stage: 'TESTNET',
        symbol: 'NEAR/USDT',
        side: 'BUY',
        type: 'MARKET',
        quantity: 100,
        maxSlippagePct: 1.0,
        idempotencyKey: 'idemp-stale-nettimeout-001',
        status: 'EXECUTING',
        createdAt: staleTimestamp,
      };

      recoveryAdapter.seedIntent(staleIntent);
      recoveryAdapter.seedCredentials(TEST_USER_ID, {
        id: 'cred-uuid-1',
        encryptedApiKey: JSON.stringify(encryptedApiKey),
        encryptedSecretKey: JSON.stringify(encryptedSecretKey),
        permissions: { read: true, trade: true, withdraw: false },
        isActive: true,
      });

      let newOrderCalled = false;

      const mockSpotClient: BinanceSpotClient = {
        newOrder: async () => {
          newOrderCalled = true;
          throw new Error('CRITICAL VIOLATION: newOrder called during recovery!');
        },
        getOrder: async () => {
          const timeoutErr = new Error('ETIMEDOUT: Connection timed out during stale query');
          timeoutErr.name = 'BinanceNetworkError';
          throw timeoutErr;
        },
      };

      const worker = new BinanceOrderWorker(recoveryAdapter, MASTER_KEY_HEX, true, () => mockSpotClient);
      const sweepRes = await worker.reconcileStaleExecutingIntents(120000);

      expect(newOrderCalled).toBe(false);
      expect(sweepRes.reconciledCount).toBe(0); // Not marked terminal

      // Stale intent remains in EXECUTING state for subsequent retry sweep
      const staleAfterSweep = await recoveryAdapter.getStaleExecutingIntents(120000);
      expect(staleAfterSweep.length).toBe(1);
      expect(staleAfterSweep[0].id).toBe(staleIntent.id);
      expect(staleAfterSweep[0].status).toBe('EXECUTING');
    });
  });
});


// ============================================================================
// GROUP D: T-07R — Order Status Semantic Correctness (NEW / PARTIALLY_FILLED)
// ============================================================================
describe('P1-06 Group D: T-07R Order Status Semantics', () => {
  const MASTER_KEY_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const TEST_USER_ID = 'usr-trader-test-uuid-001';
  const RAW_API_KEY = 'binance_live_api_key_sample_secret_token_123';
  const RAW_SECRET_KEY = 'binance_live_secret_key_super_confidential_456';
  let encryptedApiKey: any;
  let encryptedSecretKey: any;
  let mockAdapter: PostgresBinanceExecutionDbAdapter;
  beforeEach(() => {
    encryptedApiKey = BinanceCredentialVault.encrypt(RAW_API_KEY, MASTER_KEY_HEX);
    encryptedSecretKey = BinanceCredentialVault.encrypt(RAW_SECRET_KEY, MASTER_KEY_HEX);
    mockAdapter = new PostgresBinanceExecutionDbAdapter(null);
    mockAdapter.clearInMemoryState();
    mockAdapter.seedCredentials(TEST_USER_ID, { id: 'cred-uuid-1', encryptedApiKey: JSON.stringify(encryptedApiKey), encryptedSecretKey: JSON.stringify(encryptedSecretKey), permissions: { read: true, trade: true, withdraw: false }, isActive: true });
  });

  it('[T-07R][D-01] Inline reconciler: network error + exchange status NEW → retains EXECUTING, no FAILED, no duplicate newOrder', async () => {
    const intent: TradeIntentRecord = { id: crypto.randomUUID(), userId: TEST_USER_ID, stage: 'TESTNET', symbol: 'BNB/USDT', side: 'BUY', type: 'LIMIT', quantity: 10, price: 300, maxSlippagePct: 1.0, idempotencyKey: 'idemp-inline-new-001', status: 'APPROVED' };
    mockAdapter.seedIntent(intent);
    let newOrderCalls = 0, getOrderCalls = 0;
    const mockSpotClient: BinanceSpotClient = {
      newOrder: async () => { newOrderCalls++; const err = new Error('ETIMEDOUT'); err.name = 'BinanceNetworkError'; throw err; },
      getOrder: async () => { getOrderCalls++; return { symbol: 'BNBUSDT', orderId: 1111111, clientOrderId: 'idemp-inline-new-001', status: 'NEW', executedQty: 0, cummulativeQuoteQty: 0 }; },
    };
    const worker = new BinanceOrderWorker(mockAdapter, MASTER_KEY_HEX, true, () => mockSpotClient);
    const result = await worker.executeSingleIntent(intent);
    expect(newOrderCalls).toBe(1);
    expect(getOrderCalls).toBe(1);
    expect(result.status).toBe('EXECUTING');
    expect(result.success).toBe(false);
    expect(mockAdapter.getOrderFills().length).toBe(0);
  });

  it('[T-07R][D-02] Inline reconciler: network error + PARTIALLY_FILLED → fill snapshot recorded, retains EXECUTING', async () => {
    const intent: TradeIntentRecord = { id: crypto.randomUUID(), userId: TEST_USER_ID, stage: 'TESTNET', symbol: 'ETH/USDT', side: 'BUY', type: 'LIMIT', quantity: 2, price: 2000, maxSlippagePct: 1.0, idempotencyKey: 'idemp-inline-partial-001', status: 'APPROVED' };
    mockAdapter.seedIntent(intent);
    const mockSpotClient: BinanceSpotClient = {
      newOrder: async () => { const err = new Error('ECONNRESET'); err.name = 'BinanceNetworkError'; throw err; },
      getOrder: async () => ({ symbol: 'ETHUSDT', orderId: 2222222, clientOrderId: 'idemp-inline-partial-001', status: 'PARTIALLY_FILLED', executedQty: '1', cummulativeQuoteQty: '2000' }),
    };
    const worker = new BinanceOrderWorker(mockAdapter, MASTER_KEY_HEX, true, () => mockSpotClient);
    const result = await worker.executeSingleIntent(intent);
    expect(result.status).toBe('EXECUTING');
    expect(result.success).toBe(false);
    const fills = mockAdapter.getOrderFills();
    expect(fills.length).toBe(1);
    expect(fills[0].status).toBe('PARTIALLY_FILLED');
    expect(fills[0].executedQty).toBe(1);
    expect(fills[0].cummulativeQuoteQty).toBe(2000);
    const partialLog = mockAdapter.getAuditLogs().find(l => l.action === 'BINANCE_ORDER_PARTIAL_FILL_SNAPSHOT');
    expect(partialLog).toBeDefined();
    expect(partialLog?.reason).toContain('executedQty=1');
  });

  it('[T-07R][D-03] Stale reconciler: exchange status NEW → retains EXECUTING, zero fills, no newOrder', async () => {
    const recoveryAdapter = new PostgresBinanceExecutionDbAdapter(null);
    const staleTimestamp = new Date(Date.now() - 300000).toISOString();
    const staleIntent: TradeIntentRecord = { id: crypto.randomUUID(), userId: TEST_USER_ID, stage: 'TESTNET', symbol: 'DOT/USDT', side: 'BUY', type: 'LIMIT', quantity: 100, price: 7, maxSlippagePct: 1.0, idempotencyKey: 'idemp-stale-new-001', status: 'EXECUTING', createdAt: staleTimestamp };
    recoveryAdapter.seedIntent(staleIntent);
    recoveryAdapter.seedCredentials(TEST_USER_ID, { id: 'cred-uuid-1', encryptedApiKey: JSON.stringify(encryptedApiKey), encryptedSecretKey: JSON.stringify(encryptedSecretKey), permissions: { read: true, trade: true, withdraw: false }, isActive: true });
    let newOrderCalled = false;
    const mockSpotClient: BinanceSpotClient = {
      newOrder: async () => { newOrderCalled = true; throw new Error('CRITICAL'); },
      getOrder: async () => ({ symbol: 'DOTUSDT', orderId: 3333333, clientOrderId: 'idemp-stale-new-001', status: 'NEW', executedQty: 0, cummulativeQuoteQty: 0 }),
    };
    const worker = new BinanceOrderWorker(recoveryAdapter, MASTER_KEY_HEX, true, () => mockSpotClient);
    const sweepRes = await worker.reconcileStaleExecutingIntents(120000);
    expect(newOrderCalled).toBe(false);
    expect(sweepRes.reconciledCount).toBe(0);
    expect(recoveryAdapter.getOrderFills().length).toBe(0);
    const remaining = await recoveryAdapter.getStaleExecutingIntents(120000);
    expect(remaining.length).toBe(1);
    expect(remaining[0].status).toBe('EXECUTING');
  });

  it('[T-07R][D-04] Stale reconciler: PARTIALLY_FILLED → cumulative fill snapshot persisted, retains EXECUTING', async () => {
    const recoveryAdapter = new PostgresBinanceExecutionDbAdapter(null);
    const staleTimestamp = new Date(Date.now() - 300000).toISOString();
    const staleIntent: TradeIntentRecord = { id: crypto.randomUUID(), userId: TEST_USER_ID, stage: 'TESTNET', symbol: 'ADA/USDT', side: 'BUY', type: 'LIMIT', quantity: 1000, price: 0.5, maxSlippagePct: 1.0, idempotencyKey: 'idemp-stale-partial-001', status: 'EXECUTING', createdAt: staleTimestamp };
    recoveryAdapter.seedIntent(staleIntent);
    recoveryAdapter.seedCredentials(TEST_USER_ID, { id: 'cred-uuid-1', encryptedApiKey: JSON.stringify(encryptedApiKey), encryptedSecretKey: JSON.stringify(encryptedSecretKey), permissions: { read: true, trade: true, withdraw: false }, isActive: true });
    let newOrderCalled = false;
    const mockSpotClient: BinanceSpotClient = {
      newOrder: async () => { newOrderCalled = true; throw new Error('CRITICAL'); },
      getOrder: async () => ({ symbol: 'ADAUSDT', orderId: 4444444, clientOrderId: 'idemp-stale-partial-001', status: 'PARTIALLY_FILLED', executedQty: '400', cummulativeQuoteQty: '200' }),
    };
    const worker = new BinanceOrderWorker(recoveryAdapter, MASTER_KEY_HEX, true, () => mockSpotClient);
    const sweepRes = await worker.reconcileStaleExecutingIntents(120000);
    expect(newOrderCalled).toBe(false);
    expect(sweepRes.reconciledCount).toBe(0);
    const fills = recoveryAdapter.getOrderFills();
    expect(fills.length).toBe(1);
    expect(fills[0].status).toBe('PARTIALLY_FILLED');
    expect(fills[0].executedQty).toBe(400);
    expect(fills[0].cummulativeQuoteQty).toBe(200);
    const partialLog = recoveryAdapter.getAuditLogs().find(l => l.action === 'BINANCE_ORDER_PARTIAL_FILL_SNAPSHOT');
    expect(partialLog).toBeDefined();
    expect(partialLog?.reason).toContain('executedQty=400');
    const remaining = await recoveryAdapter.getStaleExecutingIntents(120000);
    expect(remaining.length).toBe(1);
    expect(remaining[0].status).toBe('EXECUTING');
  });

  it('[T-07R][D-05] FILLED: fill must be recorded before EXECUTED status is set', async () => {
    const intent: TradeIntentRecord = { id: crypto.randomUUID(), userId: TEST_USER_ID, stage: 'TESTNET', symbol: 'BTC/USDT', side: 'BUY', type: 'MARKET', quantity: 0.01, maxSlippagePct: 1.0, idempotencyKey: 'idemp-filled-gate-001', status: 'APPROVED' };
    mockAdapter.seedIntent(intent);
    const mockSpotClient: BinanceSpotClient = {
      newOrder: async () => { const err = new Error('ETIMEDOUT'); err.name = 'BinanceNetworkError'; throw err; },
      getOrder: async () => ({ symbol: 'BTCUSDT', orderId: 5555555, clientOrderId: 'idemp-filled-gate-001', status: 'FILLED', executedQty: '0.01', cummulativeQuoteQty: '630' }),
    };
    const worker = new BinanceOrderWorker(mockAdapter, MASTER_KEY_HEX, true, () => mockSpotClient);
    const result = await worker.executeSingleIntent(intent);
    expect(result.success).toBe(true);
    expect(result.status).toBe('EXECUTED');
    const fills = mockAdapter.getOrderFills();
    expect(fills.length).toBe(1);
    expect(fills[0].status).toBe('FILLED');
    expect(fills[0].cummulativeQuoteQty).toBe(630);
    expect(mockAdapter.getAuditLogs().find(l => l.action === 'BINANCE_ORDER_RECONCILED')).toBeDefined();
  });

  it('[T-07R][D-06] Stale reconciler: previously-partial order now CANCELED — FAILED transition, prior fill snapshot preserved', async () => {
    const recoveryAdapter = new PostgresBinanceExecutionDbAdapter(null);
    const staleTimestamp = new Date(Date.now() - 300000).toISOString();
    const staleIntent: TradeIntentRecord = { id: crypto.randomUUID(), userId: TEST_USER_ID, stage: 'TESTNET', symbol: 'MATIC/USDT', side: 'BUY', type: 'LIMIT', quantity: 500, price: 1, maxSlippagePct: 1.0, idempotencyKey: 'idemp-stale-canceled-001', status: 'EXECUTING', createdAt: staleTimestamp };
    recoveryAdapter.seedIntent(staleIntent);
    recoveryAdapter.seedCredentials(TEST_USER_ID, { id: 'cred-uuid-1', encryptedApiKey: JSON.stringify(encryptedApiKey), encryptedSecretKey: JSON.stringify(encryptedSecretKey), permissions: { read: true, trade: true, withdraw: false }, isActive: true });
    // Simulate prior partial fill snapshot from a previous sweep
    await recoveryAdapter.recordOrderFill({ intentId: staleIntent.id, exchangeOrderId: '6666666', symbol: staleIntent.symbol, status: 'PARTIALLY_FILLED', executedQty: 200, cummulativeQuoteQty: 200 });
    const mockSpotClient: BinanceSpotClient = {
      newOrder: async () => { throw new Error('CRITICAL'); },
      getOrder: async () => ({ symbol: 'MATICUSDT', orderId: 6666666, clientOrderId: 'idemp-stale-canceled-001', status: 'CANCELED', executedQty: '200', cummulativeQuoteQty: '200' }),
    };
    const worker = new BinanceOrderWorker(recoveryAdapter, MASTER_KEY_HEX, true, () => mockSpotClient);
    await worker.reconcileStaleExecutingIntents(120000);
    expect(recoveryAdapter.getAuditLogs().find(l => l.action === 'BINANCE_ORDER_FAILED')).toBeDefined();
    const fills = recoveryAdapter.getOrderFills();
    const partialFill = fills.find(f => f.status === 'PARTIALLY_FILLED');
    expect(partialFill).toBeDefined();
    expect(partialFill?.executedQty).toBe(200);
  });

  it('[T-07R][D-07] Network error on submit: exactly one newOrder call regardless of reconciliation result', async () => {
    const intent: TradeIntentRecord = { id: crypto.randomUUID(), userId: TEST_USER_ID, stage: 'TESTNET', symbol: 'SOL/USDT', side: 'SELL', type: 'MARKET', quantity: 5, maxSlippagePct: 1.0, idempotencyKey: 'idemp-no-dup-001', status: 'APPROVED' };
    mockAdapter.seedIntent(intent);
    let newOrderCallCount = 0;
    const mockSpotClient: BinanceSpotClient = {
      newOrder: async () => { newOrderCallCount++; const err = new Error('ETIMEDOUT'); err.name = 'BinanceNetworkError'; throw err; },
      getOrder: async () => ({ symbol: 'SOLUSDT', orderId: 7777777, clientOrderId: 'idemp-no-dup-001', status: 'NEW', executedQty: 0, cummulativeQuoteQty: 0 }),
    };
    const worker = new BinanceOrderWorker(mockAdapter, MASTER_KEY_HEX, true, () => mockSpotClient);
    const result = await worker.executeSingleIntent(intent);
    expect(newOrderCallCount).toBe(1);
    expect(result.status).toBe('EXECUTING');
  });

  it('[T-07R][D-08] Subsequent stale sweep can progress a NEW order that was retained EXECUTING from prior sweep', async () => {
    const recoveryAdapter = new PostgresBinanceExecutionDbAdapter(null);
    const staleTimestamp = new Date(Date.now() - 300000).toISOString();
    const staleIntent: TradeIntentRecord = { id: crypto.randomUUID(), userId: TEST_USER_ID, stage: 'TESTNET', symbol: 'XRP/USDT', side: 'BUY', type: 'LIMIT', quantity: 200, price: 0.6, maxSlippagePct: 1.0, idempotencyKey: 'idemp-stale-new-then-filled', status: 'EXECUTING', createdAt: staleTimestamp };
    recoveryAdapter.seedIntent(staleIntent);
    recoveryAdapter.seedCredentials(TEST_USER_ID, { id: 'cred-uuid-1', encryptedApiKey: JSON.stringify(encryptedApiKey), encryptedSecretKey: JSON.stringify(encryptedSecretKey), permissions: { read: true, trade: true, withdraw: false }, isActive: true });
    let sweepCount = 0;
    const mockSpotClient: BinanceSpotClient = {
      newOrder: async () => { throw new Error('CRITICAL'); },
      getOrder: async () => {
        sweepCount++;
        if (sweepCount === 1) return { symbol: 'XRPUSDT', orderId: 8888888, clientOrderId: 'idemp-stale-new-then-filled', status: 'NEW', executedQty: 0, cummulativeQuoteQty: 0 };
        return { symbol: 'XRPUSDT', orderId: 8888888, clientOrderId: 'idemp-stale-new-then-filled', status: 'FILLED', executedQty: 200, cummulativeQuoteQty: 120 };
      },
    };
    const worker = new BinanceOrderWorker(recoveryAdapter, MASTER_KEY_HEX, true, () => mockSpotClient);
    // Sweep 1: NEW → retained EXECUTING
    const sweep1 = await worker.reconcileStaleExecutingIntents(120000);
    expect(sweep1.reconciledCount).toBe(0);
    expect(recoveryAdapter.getOrderFills().length).toBe(0);
    const stillStale = await recoveryAdapter.getStaleExecutingIntents(120000);
    expect(stillStale.length).toBe(1);
    // Sweep 2: FILLED → EXECUTED
    const sweep2 = await worker.reconcileStaleExecutingIntents(120000);
    expect(sweep2.reconciledCount).toBe(1);
    const fills = recoveryAdapter.getOrderFills();
    expect(fills.length).toBe(1);
    expect(fills[0].status).toBe('FILLED');
    expect(fills[0].executedQty).toBe(200);
  });

  // --------------------------------------------------------------------------
  // GROUP E: GATE 3A.2R.15 PHASE A HARDENING VERIFICATION
  // --------------------------------------------------------------------------
  describe('Group E: Gate 3A.2R.15 Phase A Hardening Verification', () => {
    it('[PHASE-A][01] RealBinanceSpotClient.getOrder maps transactTime from updateTime/time fallback', async () => {
      const mockFetch = async () => {
        return new Response(
          JSON.stringify({
            symbol: 'BTCUSDT',
            orderId: 12345678,
            clientOrderId: 'idemp-time-001',
            status: 'FILLED',
            executedQty: '0.1',
            cummulativeQuoteQty: '6000',
            time: 1700000000000,
            updateTime: 1700000005000,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };

      const client = new RealBinanceSpotClient({
        apiKey: RAW_API_KEY,
        secretKey: RAW_SECRET_KEY,
        isTestnet: true,
        fetchFn: mockFetch as any,
      });

      const order = await client.getOrder('BTC/USDT', 'idemp-time-001');
      expect(order).not.toBeNull();
      expect(order?.transactTime).toBe(1700000005000);
      expect(order?.updateTime).toBe(1700000005000);
      expect(order?.time).toBe(1700000000000);
    });

    it('[PHASE-A][02] Structured -2010 Duplicate order sent triggers getOrder reconciliation and marks EXECUTED', async () => {
      const intent: TradeIntentRecord = {
        id: crypto.randomUUID(),
        userId: TEST_USER_ID,
        stage: 'TESTNET',
        symbol: 'BTC/USDT',
        side: 'BUY',
        type: 'LIMIT',
        quantity: 0.1,
        price: 60000,
        maxSlippagePct: 1.0,
        idempotencyKey: 'idemp-dup-recovery-001',
        status: 'APPROVED',
      };
      mockAdapter.seedIntent(intent);

      let getOrderCalled = false;
      const mockSpotClient: BinanceSpotClient = {
        newOrder: async () => {
          const err = new Error('Binance API Error (-2010): Duplicate order sent.');
          err.name = 'BinanceApiError';
          throw err;
        },
        getOrder: async (sym, cid) => {
          getOrderCalled = true;
          expect(sym).toBe('BTCUSDT');
          expect(cid).toBe('idemp-dup-recovery-001');
          return {
            symbol: 'BTCUSDT',
            orderId: 99887766,
            clientOrderId: cid,
            status: 'FILLED',
            executedQty: '0.1',
            cummulativeQuoteQty: '6000',
          };
        },
      };

      const worker = new BinanceOrderWorker(mockAdapter, MASTER_KEY_HEX, true, () => mockSpotClient);
      const result = await worker.executeSingleIntent(intent);

      expect(getOrderCalled).toBe(true);
      expect(result.success).toBe(true);
      expect(result.status).toBe('EXECUTED');
      expect(result.exchangeOrderId).toBe('99887766');

      const fills = mockAdapter.getOrderFills();
      expect(fills.length).toBe(1);
      expect(fills[0].exchangeOrderId).toBe('99887766');
      expect(fills[0].status).toBe('FILLED');

      const audit = mockAdapter.getAuditLogs().find((l) => l.action === 'BINANCE_ORDER_RECONCILED');
      expect(audit).toBeDefined();
      expect(audit?.reason).toContain('99887766');
    });

    it('[PHASE-A][03] Ambiguous submission query failure retains EXECUTING status without marking FAILED', async () => {
      const intent: TradeIntentRecord = {
        id: crypto.randomUUID(),
        userId: TEST_USER_ID,
        stage: 'TESTNET',
        symbol: 'SOL/USDT',
        side: 'BUY',
        type: 'MARKET',
        quantity: 5,
        maxSlippagePct: 1.0,
        idempotencyKey: 'idemp-ambig-query-fail-001',
        status: 'APPROVED',
      };
      mockAdapter.seedIntent(intent);

      const mockSpotClient: BinanceSpotClient = {
        newOrder: async () => {
          const netErr = new Error('ETIMEDOUT: Submission timed out');
          netErr.name = 'BinanceNetworkError';
          throw netErr;
        },
        getOrder: async () => {
          const queryErr = new Error('ECONNRESET: Query socket died');
          queryErr.name = 'BinanceNetworkError';
          throw queryErr;
        },
      };

      const worker = new BinanceOrderWorker(mockAdapter, MASTER_KEY_HEX, true, () => mockSpotClient);
      const result = await worker.executeSingleIntent(intent);

      expect(result.success).toBe(false);
      expect(result.status).toBe('EXECUTING');
      expect(mockAdapter.getOrderFills().length).toBe(0);

      const ambigLog = mockAdapter.getAuditLogs().find((l) => l.action === 'BINANCE_ORDER_SUBMISSION_AMBIGUOUS');
      expect(ambigLog).toBeDefined();
    });

    it('[PHASE-A][04] Pre-dispatch kill switch aborts before calling newOrder', async () => {
      const intent: TradeIntentRecord = {
        id: crypto.randomUUID(),
        userId: TEST_USER_ID,
        stage: 'TESTNET',
        symbol: 'BNB/USDT',
        side: 'BUY',
        type: 'MARKET',
        quantity: 2,
        maxSlippagePct: 1.0,
        idempotencyKey: 'idemp-pre-dispatch-ks-001',
        status: 'APPROVED',
      };
      mockAdapter.seedIntent(intent);

      let checkCount = 0;
      let newOrderCalled = false;
      spyOn(mockAdapter, 'getActiveKillSwitches').mockImplementation(async () => {
        checkCount++;
        if (checkCount >= 2) {
          return [{ id: 'ks-pre-dispatch', scope: 'GLOBAL', isActive: true, reason: 'Emergency Pre-Dispatch Halt' }];
        }
        return [];
      });

      const mockSpotClient: BinanceSpotClient = {
        newOrder: async () => {
          newOrderCalled = true;
          throw new Error('Should not be called');
        },
        getOrder: async () => null,
      };

      const worker = new BinanceOrderWorker(mockAdapter, MASTER_KEY_HEX, true, () => mockSpotClient);
      const result = await worker.executeSingleIntent(intent);

      expect(newOrderCalled).toBe(false);
      expect(result.success).toBe(false);
      expect(result.status).toBe('CANCELLED');
      expect(result.error).toContain('PRE_DISPATCH_KILL_SWITCH_BLOCKED');

      const audit = mockAdapter.getAuditLogs().find((l) => l.action === 'INTENT_CANCELLED_BY_KILL_SWITCH');
      expect(audit).toBeDefined();
      expect(audit?.reason).toContain('Emergency Pre-Dispatch Halt');
    });

    it('[PHASE-A][05] Post-dispatch kill switch triggers emergency cancelOrder and marks CANCELLED', async () => {
      const intent: TradeIntentRecord = {
        id: crypto.randomUUID(),
        userId: TEST_USER_ID,
        stage: 'TESTNET',
        symbol: 'ETH/USDT',
        side: 'BUY',
        type: 'LIMIT',
        quantity: 1,
        price: 2500,
        maxSlippagePct: 1.0,
        idempotencyKey: 'idemp-post-dispatch-ks-001',
        status: 'APPROVED',
      };
      mockAdapter.seedIntent(intent);

      let checkCount = 0;
      let cancelCalled = false;
      spyOn(mockAdapter, 'getActiveKillSwitches').mockImplementation(async () => {
        checkCount++;
        if (checkCount >= 3) {
          return [{ id: 'ks-post-dispatch', scope: 'USER', targetId: TEST_USER_ID, isActive: true, reason: 'Risk Limit Breach' }];
        }
        return [];
      });

      const mockSpotClient: BinanceSpotClient = {
        newOrder: async () => {
          return {
            symbol: 'ETHUSDT',
            orderId: 77112233,
            clientOrderId: 'idemp-post-dispatch-ks-001',
            status: 'NEW',
            executedQty: '0',
            cummulativeQuoteQty: '0',
          };
        },
        getOrder: async () => null,
        cancelOrder: async (sym, cid) => {
          cancelCalled = true;
          expect(sym).toBe('ETHUSDT');
          expect(cid).toBe('idemp-post-dispatch-ks-001');
          return {
            symbol: 'ETHUSDT',
            orderId: 77112233,
            clientOrderId: cid,
            status: 'CANCELED',
            executedQty: '0',
            cummulativeQuoteQty: '0',
          };
        },
      };

      const worker = new BinanceOrderWorker(mockAdapter, MASTER_KEY_HEX, true, () => mockSpotClient);
      const result = await worker.executeSingleIntent(intent);

      expect(cancelCalled).toBe(true);
      expect(result.status).toBe('CANCELLED');
      expect(result.success).toBe(false);

      const fills = mockAdapter.getOrderFills();
      expect(fills.length).toBe(1);
      expect(fills[0].status).toBe('CANCELED');

      const audit = mockAdapter.getAuditLogs().find((l) => l.action === 'INTENT_CANCELLED_BY_KILL_SWITCH');
      expect(audit).toBeDefined();
      expect(audit?.reason).toContain('Emergency halt applied post-dispatch');
    });

    it('[PHASE-A][06] OrderSnapshotStateMachine enforces tuple integrity and rejects quote quantity regression', () => {
      const existing = {
        intentId: 'intent-tuple-01',
        exchangeOrderId: '112233',
        symbol: 'BTCUSDT',
        status: 'PARTIALLY_FILLED',
        executedQty: 10,
        cummulativeQuoteQty: 500,
      };

      const invalidIncoming = {
        intentId: 'intent-tuple-01',
        exchangeOrderId: '112233',
        symbol: 'BTCUSDT',
        status: 'FILLED',
        executedQty: 20,
        cummulativeQuoteQty: 400,
      };

      expect(() => OrderSnapshotStateMachine.evaluateTransition(existing, invalidIncoming)).toThrow(
        /INCONSISTENT_SNAPSHOT/
      );
    });

    it('[PHASE-A][07] OrderSnapshotStateMachine treats repeated identical snapshot as NO_OP_IDENTICAL', () => {
      const existing = {
        intentId: 'intent-ident-01',
        exchangeOrderId: '445566',
        symbol: 'BTCUSDT',
        status: 'FILLED',
        executedQty: 1.5,
        cummulativeQuoteQty: 90000,
      };

      const identical = {
        intentId: 'intent-ident-01',
        exchangeOrderId: '445566',
        symbol: 'BTCUSDT',
        status: 'FILLED',
        executedQty: 1.5,
        cummulativeQuoteQty: 90000,
      };

      const transition = OrderSnapshotStateMachine.evaluateTransition(existing, identical);
      expect(transition.action).toBe('NO_OP_IDENTICAL');
    });

    it('[PHASE-A][08] OrderSnapshotStateMachine protects terminal FILLED state from stale lower-quantity updates', () => {
      const existing = {
        intentId: 'intent-term-01',
        exchangeOrderId: '778899',
        symbol: 'BTCUSDT',
        status: 'FILLED',
        executedQty: 2.0,
        cummulativeQuoteQty: 120000,
      };

      const lateStale = {
        intentId: 'intent-term-01',
        exchangeOrderId: '778899',
        symbol: 'BTCUSDT',
        status: 'PARTIALLY_FILLED',
        executedQty: 1.0,
        cummulativeQuoteQty: 60000,
      };

      const transition = OrderSnapshotStateMachine.evaluateTransition(existing, lateStale);
      expect(transition.action).toBe('IGNORED_STALE');
    });

    it('[PHASE-A][09] Concurrent recordOrderFill on same intent updates existing record without duplicate rows', async () => {
      const sharedAdapter = new PostgresBinanceExecutionDbAdapter(null);
      const intentId = crypto.randomUUID();
      sharedAdapter.seedIntent({
        id: intentId,
        userId: TEST_USER_ID,
        stage: 'TESTNET',
        symbol: 'BTC/USDT',
        side: 'BUY',
        type: 'LIMIT',
        quantity: 1.0,
        price: 60000,
        maxSlippagePct: 1.0,
        idempotencyKey: 'idemp-concur-01',
        status: 'EXECUTING',
      });

      await sharedAdapter.recordOrderFill({
        intentId,
        exchangeOrderId: 'BNB-CONCUR-1',
        symbol: 'BTCUSDT',
        status: 'PARTIALLY_FILLED',
        executedQty: 0.5,
        cummulativeQuoteQty: 30000,
      });

      await sharedAdapter.recordOrderFill({
        intentId,
        exchangeOrderId: 'BNB-CONCUR-1',
        symbol: 'BTCUSDT',
        status: 'FILLED',
        executedQty: 1.0,
        cummulativeQuoteQty: 60000,
      });

      const fills = sharedAdapter.getOrderFills();
      expect(fills.length).toBe(1);
      expect(fills[0].status).toBe('FILLED');
      expect(fills[0].executedQty).toBe(1.0);
      expect(fills[0].cummulativeQuoteQty).toBe(60000);
    });

    it('[PHASE-A][10] Parent intent missing in recordOrderFill throws PARENT_INTENT_NOT_FOUND (fail-closed)', async () => {
      const adapter = new PostgresBinanceExecutionDbAdapter(null);
      const nonExistentId = crypto.randomUUID();

      await expect(
        adapter.recordOrderFill({
          intentId: nonExistentId,
          exchangeOrderId: 'BNB-NOPARENT-1',
          symbol: 'BTCUSDT',
          status: 'FILLED',
          executedQty: 1.0,
          cummulativeQuoteQty: 60000,
        })
      ).rejects.toThrow(/PARENT_INTENT_NOT_FOUND/);

      expect(adapter.getOrderFills().length).toBe(0);
      expect(adapter.getAuditLogs().length).toBe(0);
    });

    it('[PHASE-A][11] Mutex released after validation failure', async () => {
      const adapter = new PostgresBinanceExecutionDbAdapter(null);
      const intentId = crypto.randomUUID();
      adapter.seedIntent({
        id: intentId,
        userId: TEST_USER_ID,
        stage: 'TESTNET',
        symbol: 'BTC/USDT',
        side: 'BUY',
        type: 'LIMIT',
        quantity: 1.0,
        idempotencyKey: 'idemp-mutex-rel-01',
        status: 'EXECUTING',
      });

      // Operation 1 fails with status error
      await expect(
        adapter.recordOrderFill({
          intentId,
          exchangeOrderId: 'BNB-MUTEX-1',
          symbol: 'BTCUSDT',
          status: 'MALFORMED_STATUS' as any,
          executedQty: 1.0,
          cummulativeQuoteQty: 60000,
        })
      ).rejects.toThrow(/INVALID_ORDER_STATUS/);

      // Operation 2 on same intent must not deadlock and must succeed
      await adapter.recordOrderFill({
        intentId,
        exchangeOrderId: 'BNB-MUTEX-1',
        symbol: 'BTCUSDT',
        status: 'FILLED',
        executedQty: 1.0,
        cummulativeQuoteQty: 60000,
      });

      const fills = adapter.getOrderFills();
      expect(fills.length).toBe(1);
      expect(fills[0].status).toBe('FILLED');
    });

    it('[PHASE-A][12] No ghost in-memory state after failed mutation', async () => {
      const adapter = new PostgresBinanceExecutionDbAdapter(null);
      const intentId = crypto.randomUUID();
      adapter.seedIntent({
        id: intentId,
        userId: TEST_USER_ID,
        stage: 'TESTNET',
        symbol: 'BTC/USDT',
        side: 'BUY',
        type: 'LIMIT',
        quantity: 1.0,
        idempotencyKey: 'idemp-ghost-01',
        status: 'EXECUTING',
      });

      // Valid initial partial fill
      await adapter.recordOrderFill({
        intentId,
        exchangeOrderId: 'BNB-GHOST-1',
        symbol: 'BTCUSDT',
        status: 'PARTIALLY_FILLED',
        executedQty: 0.5,
        cummulativeQuoteQty: 30000,
      });

      expect(adapter.getOrderFills().length).toBe(1);

      // Invalid quote regression attempt: must throw INCONSISTENT_SNAPSHOT
      await expect(
        adapter.recordOrderFill({
          intentId,
          exchangeOrderId: 'BNB-GHOST-1',
          symbol: 'BTCUSDT',
          status: 'FILLED',
          executedQty: 1.0,
          cummulativeQuoteQty: 25000, // regressed from 30000!
        })
      ).rejects.toThrow(/INCONSISTENT_SNAPSHOT/);

      // State must remain strictly at 0.5 / 30000 (no partial mutation or ghost state)
      const fills = adapter.getOrderFills();
      expect(fills.length).toBe(1);
      expect(fills[0].executedQty).toBe(0.5);
      expect(fills[0].cummulativeQuoteQty).toBe(30000);
      expect(fills[0].status).toBe('PARTIALLY_FILLED');
    });

    it('[PHASE-A][13] Audit insertion failure in PostgreSQL transaction rolls back related writes', async () => {
      const intentId = crypto.randomUUID();
      let rollbackInvoked = false;

      const mockClient = {
        query: async (sql: string, params?: any[]) => {
          if (sql === 'BEGIN') return {};
          if (sql.includes('SELECT id, status, user_id')) {
            return { rows: [{ id: intentId, status: 'EXECUTING', userId: TEST_USER_ID }] };
          }
          if (sql.includes('SELECT id, intent_id')) {
            return { rows: [] };
          }
          if (sql.includes('INSERT INTO orders')) {
            return { rows: [] };
          }
          if (sql.includes('INSERT INTO audit_logs')) {
            throw new Error('Neon DB connection timeout during audit_logs insert');
          }
          if (sql === 'ROLLBACK') {
            rollbackInvoked = true;
            return {};
          }
          return { rows: [] };
        },
        release: () => {},
      };

      const mockPool = {
        connect: async () => mockClient,
      } as any;

      const pgAdapter = new PostgresBinanceExecutionDbAdapter(mockPool);

      await expect(
        pgAdapter.recordOrderFill({
          intentId,
          exchangeOrderId: 'BNB-AUDIT-FAIL-1',
          symbol: 'BTCUSDT',
          status: 'FILLED',
          executedQty: 1.0,
          cummulativeQuoteQty: 60000,
        })
      ).rejects.toThrow(/audit_logs insert/);

      expect(rollbackInvoked).toBe(true);
    });

    it('[PHASE-A][14] Post-dispatch emergency cancellation timeout retains EXECUTING status (unresolved cancel)', async () => {
      const intent: TradeIntentRecord = {
        id: crypto.randomUUID(),
        userId: TEST_USER_ID,
        stage: 'TESTNET',
        symbol: 'ETH/USDT',
        side: 'BUY',
        type: 'LIMIT',
        quantity: 1,
        price: 2500,
        maxSlippagePct: 1.0,
        idempotencyKey: 'idemp-cancel-timeout-001',
        status: 'APPROVED',
      };
      mockAdapter.seedIntent(intent);

      let checkCount = 0;
      spyOn(mockAdapter, 'getActiveKillSwitches').mockImplementation(async () => {
        checkCount++;
        if (checkCount >= 3) {
          return [{ id: 'ks-post-timeout', scope: 'GLOBAL', isActive: true, reason: 'Market Emergency' }];
        }
        return [];
      });

      const mockSpotClient: BinanceSpotClient = {
        newOrder: async () => ({
          symbol: 'ETHUSDT',
          orderId: 88223344,
          clientOrderId: 'idemp-cancel-timeout-001',
          status: 'NEW',
          executedQty: '0',
          cummulativeQuoteQty: '0',
        }),
        getOrder: async () => {
          const err = new Error('ETIMEDOUT: Query timeout');
          err.name = 'BinanceNetworkError';
          throw err;
        },
        cancelOrder: async () => {
          const err = new Error('ETIMEDOUT: Cancel timeout');
          err.name = 'BinanceNetworkError';
          throw err;
        },
      };

      const worker = new BinanceOrderWorker(mockAdapter, MASTER_KEY_HEX, true, () => mockSpotClient);
      const result = await worker.executeSingleIntent(intent);

      expect(result.success).toBe(false);
      expect(result.status).toBe('EXECUTING');
      expect(result.error).toContain('retaining EXECUTING');

      const audit = mockAdapter.getAuditLogs().find((l) => l.action === 'BINANCE_KILL_SWITCH_CANCEL_UNRESOLVED');
      expect(audit).toBeDefined();

      const remaining = await mockAdapter.getStaleExecutingIntents(0);
      expect(remaining.some((i) => i.id === intent.id)).toBe(true);
    });

    it('[PHASE-A][15] newOrder() timeout while kill switch is active attempts cancel and retains EXECUTING if unconfirmed', async () => {
      const intent: TradeIntentRecord = {
        id: crypto.randomUUID(),
        userId: TEST_USER_ID,
        stage: 'TESTNET',
        symbol: 'SOL/USDT',
        side: 'SELL',
        type: 'MARKET',
        quantity: 10,
        maxSlippagePct: 1.0,
        idempotencyKey: 'idemp-submit-ks-timeout-001',
        status: 'APPROVED',
      };
      mockAdapter.seedIntent(intent);

      let checkCount = 0;
      spyOn(mockAdapter, 'getActiveKillSwitches').mockImplementation(async () => {
        checkCount++;
        // Trip kill switch during submit error recovery
        if (checkCount >= 3) {
          return [{ id: 'ks-submit-err', scope: 'GLOBAL', isActive: true, reason: 'Circuit Breaker' }];
        }
        return [];
      });

      let cancelAttempted = false;
      const mockSpotClient: BinanceSpotClient = {
        newOrder: async () => {
          const netErr = new Error('ETIMEDOUT: Submission timed out');
          netErr.name = 'BinanceNetworkError';
          throw netErr;
        },
        getOrder: async () => {
          const queryErr = new Error('ETIMEDOUT: Query timed out');
          queryErr.name = 'BinanceNetworkError';
          throw queryErr;
        },
        cancelOrder: async () => {
          cancelAttempted = true;
          const cancelErr = new Error('ETIMEDOUT: Emergency cancel timed out');
          cancelErr.name = 'BinanceNetworkError';
          throw cancelErr;
        },
      };

      const worker = new BinanceOrderWorker(mockAdapter, MASTER_KEY_HEX, true, () => mockSpotClient);
      const result = await worker.executeSingleIntent(intent);

      expect(cancelAttempted).toBe(true);
      expect(result.success).toBe(false);
      expect(result.status).toBe('EXECUTING');

      const audit = mockAdapter.getAuditLogs().find((l) => l.action === 'BINANCE_KILL_SWITCH_CANCEL_UNRESOLVED');
      expect(audit).toBeDefined();
    });

    it('[PHASE-A][16] OrderSnapshotStateMachine allows authoritative FILLED evidence to supersede prior CANCELED state', () => {
      const existing = {
        intentId: 'intent-term-supersede-01',
        exchangeOrderId: '991122',
        symbol: 'BTCUSDT',
        status: 'CANCELED',
        executedQty: 0,
        cummulativeQuoteQty: 0,
      };

      const authoritativeFilled = {
        intentId: 'intent-term-supersede-01',
        exchangeOrderId: '991122',
        symbol: 'BTCUSDT',
        status: 'FILLED',
        executedQty: 1.0,
        cummulativeQuoteQty: 60000,
      };

      const transition = OrderSnapshotStateMachine.evaluateTransition(existing, authoritativeFilled);
      expect(transition.action).toBe('APPLY_UPDATE');
    });

    it('[PHASE-A][17] OrderSnapshotStateMachine rejects malformed/unknown status with INVALID_ORDER_STATUS', () => {
      const invalid = {
        intentId: 'intent-bad-status-01',
        exchangeOrderId: '123',
        symbol: 'BTCUSDT',
        status: 'UNKNOWN_CUSTOM_STATUS',
        executedQty: 1.0,
        cummulativeQuoteQty: 60000,
      };

      expect(() => OrderSnapshotStateMachine.evaluateTransition(null, invalid)).toThrow(
        /INVALID_ORDER_STATUS/
      );
    });

    it('[PHASE-A][18] Contradictory exchange terminal evidence (CANCELED after FILLED) is ignored as stale', () => {
      const existing = {
        intentId: 'intent-term-conflict-01',
        exchangeOrderId: '773344',
        symbol: 'BTCUSDT',
        status: 'FILLED',
        executedQty: 2.0,
        cummulativeQuoteQty: 120000,
      };

      const contradictoryCanceled = {
        intentId: 'intent-term-conflict-01',
        exchangeOrderId: '773344',
        symbol: 'BTCUSDT',
        status: 'CANCELED',
        executedQty: 0,
        cummulativeQuoteQty: 0,
      };

      const transition = OrderSnapshotStateMachine.evaluateTransition(existing, contradictoryCanceled);
      expect(transition.action).toBe('IGNORED_STALE');
      expect(transition.reason).toContain('contradictory incoming CANCELED ignored');
    });

    it('[PHASE-A][19] Concurrent first insert serialization via mutex queue on same intent', async () => {
      const sharedAdapter = new PostgresBinanceExecutionDbAdapter(null);
      const intentId = crypto.randomUUID();
      sharedAdapter.seedIntent({
        id: intentId,
        userId: TEST_USER_ID,
        stage: 'TESTNET',
        symbol: 'BTC/USDT',
        side: 'BUY',
        type: 'LIMIT',
        quantity: 1.0,
        price: 60000,
        maxSlippagePct: 1.0,
        idempotencyKey: 'idemp-racing-inserts-01',
        status: 'EXECUTING',
      });

      // Racing two operations concurrently on the same intent
      await Promise.all([
        sharedAdapter.recordOrderFill({
          intentId,
          exchangeOrderId: 'BNB-RACE-1',
          symbol: 'BTCUSDT',
          status: 'PARTIALLY_FILLED',
          executedQty: 0.5,
          cummulativeQuoteQty: 30000,
        }),
        sharedAdapter.recordOrderFill({
          intentId,
          exchangeOrderId: 'BNB-RACE-1',
          symbol: 'BTCUSDT',
          status: 'FILLED',
          executedQty: 1.0,
          cummulativeQuoteQty: 60000,
        }),
      ]);

      const fills = sharedAdapter.getOrderFills();
      expect(fills.length).toBe(1);
      expect(fills[0].status).toBe('FILLED');
      expect(fills[0].executedQty).toBe(1.0);
      expect(fills[0].cummulativeQuoteQty).toBe(60000);
    });
  });

});
