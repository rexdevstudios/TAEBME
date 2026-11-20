import * as crypto from 'crypto';
import { BinanceCredentialVault, EncryptedPayload } from '../../../packages/trading/binance-vault';
import { TradeIntentInput, BinanceKeyPermissions } from '../../../packages/shared/types/domain';
import type { TradeIntentRecord, BinanceExecutionDbAdapter } from '../../../packages/trading/execution-types';

export type { TradeIntentRecord, BinanceExecutionDbAdapter };

export interface BinanceNewOrderParams {
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'LIMIT' | 'MARKET' | 'STOP_LOSS' | 'TAKE_PROFIT';
  quantity: number;
  price?: number;
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
  newClientOrderId: string;
  recvWindow?: number;
}

export interface BinanceOrderResponse {
  symbol: string;
  orderId: number | string;
  clientOrderId: string;
  status: 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'PENDING_CANCEL' | 'REJECTED' | 'EXPIRED';
  executedQty: string | number;
  cummulativeQuoteQty: string | number;
  price?: string | number;
  origQty?: string | number;
  side?: string;
  type?: string;
  transactTime?: number;
  updateTime?: number;
  time?: number;
}

export interface BinanceSpotClient {
  newOrder(params: BinanceNewOrderParams): Promise<BinanceOrderResponse>;
  getOrder(symbol: string, origClientOrderId: string): Promise<BinanceOrderResponse | null>;
  cancelOrder?(symbol: string, origClientOrderId: string): Promise<BinanceOrderResponse | null>;
  getServerTime?(): Promise<{ serverTime: number }>;
  getExchangeInfo?(symbol?: string): Promise<any>;
  getAccountInformation?(): Promise<any>;
  getApiRestrictions?(): Promise<any>;
}

export type BinanceErrorClassification =
  | 'DEFINITIVE_REJECTION'
  | 'DUPLICATE_CLIENT_ORDER_ID'
  | 'AMBIGUOUS_OUTCOME';

export interface ClassifiedBinanceError {
  classification: BinanceErrorClassification;
  code?: number;
  httpStatus?: number;
  reason: string;
}

/**
 * Verified Binance error codes that guarantee pre-trade rejection
 * before order matching engine acceptance.
 */
export const BINANCE_DEFINITIVE_REJECTION_CODES: ReadonlySet<number> = new Set([
  -1013, // Filter failure (LOT_SIZE, MIN_NOTIONAL, PRICE_FILTER, etc.)
  -1022, // Invalid HMAC signature (rejected at API gateway before matching engine)
  -1100, // Illegal characters
  -1101, // Too many parameters
  -1102, // Mandatory parameter empty or invalid
  -1103, // Unknown parameter
  -1104, // Unread parameter
  -1105, // Parameter empty
  -1106, // Parameter not required
  -1111, // Bad precision
  -1112, // No depth
  -1114, // TimeInForce not required
  -1115, // Invalid timeInForce
  -1116, // Invalid orderType
  -1117, // Invalid side
  -1118, // Empty newClientOrderId
  -1119, // Empty origClientOrderId
  -1120, // Bad interval
  -1121, // Bad symbol
  -1125, // Invalid listenKey
  -1127, // Interval too large
  -1128, // Optional parameter error
  -1130, // Invalid parameter
  -2010, // Account has insufficient balance / pre-trade matching engine rejection (unless duplicate)
]);

/**
 * Exact authorized patterns from Binance for duplicate clientOrderId rejection.
 * Prevents overly broad substring matching from misclassifying unrelated errors.
 */
export const BINANCE_AUTHORIZED_DUPLICATE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bduplicate order sent\b/i,
  /\border already exists\b/i,
  /\bduplicate client[_\s]?order[_\s]?id\b/i,
];

/**
 * Categorizes Binance order submission errors into:
 * 1. DEFINITIVE_REJECTION: Verified pre-trade validation error codes only (including -1022 invalid signature).
 * 2. DUPLICATE_CLIENT_ORDER_ID: Idempotency conflict requiring lookup query (bounded to authorized patterns).
 * 3. AMBIGUOUS_OUTCOME: Network timeouts, disconnects, HTTP 5xx/408/429, or unverified codes.
 */
export function classifyBinanceError(err: any): ClassifiedBinanceError {
  const msg = (err?.message || String(err)).toLowerCase();
  let code: number | undefined = typeof err?.code === 'number' ? err.code : undefined;
  const httpStatus: number | undefined = typeof err?.httpStatus === 'number' ? err.httpStatus : undefined;

  // Extract numeric code from message pattern like "(-2010)" or "code: -1013" if err.code is not set
  if (code === undefined) {
    const codeMatch = err?.message?.match(/\((-?\d+)\)/) || err?.message?.match(/code[:=\s]+(-?\d+)/i);
    if (codeMatch) {
      code = parseInt(codeMatch[1], 10);
    }
  }

  // 1. Check for Invalid Signature (-1022)
  // Binance -1022 is INVALID_SIGNATURE ("Signature for this request is not valid.")
  // This is a definitive pre-trade rejection by the API gateway before matching engine processing.
  const isInvalidSignature =
    code === -1022 ||
    msg.includes('signature for this request is not valid') ||
    msg.includes('invalid signature');

  if (isInvalidSignature) {
    return {
      classification: 'DEFINITIVE_REJECTION',
      code: code ?? -1022,
      httpStatus,
      reason: err?.message || 'Invalid signature rejection by Binance API gateway (code: -1022)',
    };
  }

  // 2. Check for Duplicate Client Order ID
  // Binance duplicate order contract:
  // Strictly requires BOTH verified code (-2010 NEW_ORDER_REJECTED) AND authorized duplicate message pattern:
  //   - "duplicate order sent"
  //   - "order already exists"
  //   - "duplicate clientOrderId"
  // Unrelated duplicate substrings or duplicate messages with unauthorized/unknown error codes are strictly rejected.
  const hasAuthorizedDuplicateMsg = BINANCE_AUTHORIZED_DUPLICATE_PATTERNS.some((pat) => pat.test(msg));
  const isDuplicate =
    hasAuthorizedDuplicateMsg &&
    (code === -2010);

  if (isDuplicate) {
    return {
      classification: 'DUPLICATE_CLIENT_ORDER_ID',
      code,
      httpStatus,
      reason: err?.message || 'Duplicate client order ID detected on Binance',
    };
  }

  // 3. Check for Ambiguous Outcomes (Network, Timeout, Rate limit, Server error, or ambiguous codes)
  const isNetwork =
    err?.name === 'BinanceNetworkError' ||
    err?.name === 'AbortError' ||
    err?.name === 'FetchError' ||
    msg.includes('etimedout') ||
    msg.includes('econnreset') ||
    msg.includes('econnaborted') ||
    msg.includes('socket hang up') ||
    msg.includes('network error') ||
    msg.includes('fetch failed');

  const isServerOrTimeout =
    err?.name === 'BinanceServerError' ||
    (httpStatus !== undefined && httpStatus >= 500) ||
    httpStatus === 408 ||
    httpStatus === 429 ||
    httpStatus === 403;

  const isAmbiguousCode =
    code === -1000 || // Unknown error
    code === -1001 || // Disconnected
    code === -1003 || // Too many requests / rate limit
    code === -1006 || // Unexpected response
    code === -1007 || // Timeout waiting for response
    code === -1021;   // Timestamp outside recvWindow

  if (isNetwork || isServerOrTimeout || isAmbiguousCode) {
    return {
      classification: 'AMBIGUOUS_OUTCOME',
      code,
      httpStatus,
      reason: err?.message || 'Network, timeout, rate limit, or server ambiguity',
    };
  }

  // 4. Check for Definitive Rejections (verified pre-trade codes)
  if (code !== undefined && BINANCE_DEFINITIVE_REJECTION_CODES.has(code)) {
    let rejectionDetail = `Definitive rejection by Binance pre-trade filter (code: ${code})`;
    if (code === -2010) {
      rejectionDetail = msg.includes('insufficient balance')
        ? `Insufficient balance rejection by Binance (code: -2010)`
        : `New order rejected pre-trade by Binance matching engine (code: -2010)`;
    }
    return {
      classification: 'DEFINITIVE_REJECTION',
      code,
      httpStatus,
      reason: err?.message || rejectionDetail,
    };
  }

  // 5. Fail-safe: Unverified error codes or general HTTP 4xx must NOT be assumed zero-execution
  return {
    classification: 'AMBIGUOUS_OUTCOME',
    code,
    httpStatus,
    reason: `Unverified error (code=${code}, status=${httpStatus}): ${err?.message || 'Unknown error'} — fail-safe retaining EXECUTING`,
  };
}

/**
 * Real Signed Binance Spot REST API Client
 * - Computes HMAC-SHA256 query signature
 * - Attaches X-MBX-APIKEY header
 * - Redacts sensitive keys from errors
 */
export class RealBinanceSpotClient implements BinanceSpotClient {
  private baseUrl: string;
  private apiKey: string;
  private secretKey: string;
  private recvWindow: number;
  private customFetch?: typeof fetch;

  constructor(config: {
    apiKey: string;
    secretKey: string;
    isTestnet?: boolean;
    baseUrl?: string;
    recvWindow?: number;
    fetchFn?: typeof fetch;
  }) {
    this.apiKey = config.apiKey;
    this.secretKey = config.secretKey;
    this.recvWindow = config.recvWindow ?? 5000;
    this.customFetch = config.fetchFn;

    if (config.baseUrl) {
      this.baseUrl = config.baseUrl;
    } else {
      this.baseUrl = config.isTestnet
        ? 'https://testnet.binance.vision/api/v3'
        : 'https://api.binance.com/api/v3';
    }
  }

  private signQuery(queryString: string): string {
    return crypto.createHmac('sha256', this.secretKey).update(queryString).digest('hex');
  }

  /**
   * Strips/redacts sensitive keys, secrets, and signatures from error messages
   */
  private sanitizeError(err: any): Error {
    let rawMsg = err?.message || String(err);
    if (this.apiKey) {
      rawMsg = rawMsg.replace(new RegExp(this.apiKey, 'g'), '[REDACTED_API_KEY]');
    }
    if (this.secretKey) {
      rawMsg = rawMsg.replace(new RegExp(this.secretKey, 'g'), '[REDACTED_SECRET_KEY]');
    }
    rawMsg = rawMsg.replace(/signature=[a-f0-9]{64}/gi, 'signature=[REDACTED_SIGNATURE]');
    const error: any = new Error(rawMsg);
    if (err?.name) error.name = err.name;
    if (err?.code !== undefined) error.code = err.code;
    if (err?.httpStatus !== undefined) error.httpStatus = err.httpStatus;
    return error;
  }

  async newOrder(params: BinanceNewOrderParams): Promise<BinanceOrderResponse> {
    const fetchImpl = this.customFetch || fetch;
    const queryParams: Record<string, string> = {
      symbol: params.symbol.replace('/', '').toUpperCase(),
      side: params.side,
      type: params.type,
      quantity: String(params.quantity),
      newClientOrderId: params.newClientOrderId,
      recvWindow: String(this.recvWindow),
      timestamp: String(Date.now()),
    };

    if (params.type === 'LIMIT' && params.price) {
      queryParams.price = String(params.price);
      queryParams.timeInForce = params.timeInForce || 'GTC';
    }

    const queryStr = new URLSearchParams(queryParams).toString();
    const signature = this.signQuery(queryStr);
    const fullQuery = `${queryStr}&signature=${signature}`;
    const url = `${this.baseUrl}/order?${fullQuery}`;

    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'X-MBX-APIKEY': this.apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });
    } catch (networkErr: any) {
      const sanitizedErr = this.sanitizeError(networkErr);
      sanitizedErr.name = 'BinanceNetworkError';
      throw sanitizedErr;
    }

    if (!res.ok) {
      let errBody: any = {};
      try {
        errBody = await res.json();
      } catch {
        errBody = { msg: res.statusText };
      }

      if (res.status >= 500) {
        const err: any = new Error(`Binance 5xx Server Error (${res.status}): ${errBody.msg || 'Internal Server Error'}`);
        err.name = 'BinanceServerError';
        err.httpStatus = res.status;
        err.code = typeof errBody.code === 'number' ? errBody.code : undefined;
        throw this.sanitizeError(err);
      }

      const err: any = new Error(`Binance API Error (${errBody.code || res.status}): ${errBody.msg || 'Order rejected'}`);
      err.name = 'BinanceApiError';
      err.httpStatus = res.status;
      err.code = typeof errBody.code === 'number' ? errBody.code : undefined;
      throw this.sanitizeError(err);
    }

    const data = await res.json();
    return {
      symbol: data.symbol,
      orderId: data.orderId,
      clientOrderId: data.clientOrderId,
      status: data.status,
      executedQty: data.executedQty,
      cummulativeQuoteQty: data.cummulativeQuoteQty,
      price: data.price,
      origQty: data.origQty,
      side: data.side,
      type: data.type,
      transactTime: data.transactTime,
    };
  }

  async getOrder(symbol: string, origClientOrderId: string): Promise<BinanceOrderResponse | null> {
    const fetchImpl = this.customFetch || fetch;
    const queryParams: Record<string, string> = {
      symbol: symbol.replace('/', '').toUpperCase(),
      origClientOrderId,
      recvWindow: String(this.recvWindow),
      timestamp: String(Date.now()),
    };

    const queryStr = new URLSearchParams(queryParams).toString();
    const signature = this.signQuery(queryStr);
    const fullQuery = `${queryStr}&signature=${signature}`;
    const url = `${this.baseUrl}/order?${fullQuery}`;

    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'GET',
        headers: {
          'X-MBX-APIKEY': this.apiKey,
        },
      });
    } catch (networkErr: any) {
      const sanitizedErr = this.sanitizeError(networkErr);
      sanitizedErr.name = 'BinanceNetworkError';
      throw sanitizedErr;
    }

    if (!res.ok) {
      let errBody: any = {};
      try {
        errBody = await res.json();
      } catch {
        errBody = { msg: res.statusText };
      }

      // If Binance returns code -2013: "Order does not exist" or HTTP 404
      if (errBody.code === -2013 || res.status === 404) {
        return null;
      }

      if (res.status >= 500) {
        const err: any = new Error(`Binance 5xx Server Error on Query (${res.status}): ${errBody.msg || 'Internal Server Error'}`);
        err.name = 'BinanceServerError';
        err.httpStatus = res.status;
        err.code = typeof errBody.code === 'number' ? errBody.code : undefined;
        throw this.sanitizeError(err);
      }

      const err: any = new Error(`Binance API Query Error (${errBody.code || res.status}): ${errBody.msg || 'Query failed'}`);
      err.name = 'BinanceApiError';
      err.httpStatus = res.status;
      err.code = typeof errBody.code === 'number' ? errBody.code : undefined;
      throw this.sanitizeError(err);
    }

    const data = await res.json();
    return {
      symbol: data.symbol,
      orderId: data.orderId,
      clientOrderId: data.clientOrderId,
      status: data.status,
      executedQty: data.executedQty,
      cummulativeQuoteQty: data.cummulativeQuoteQty,
      price: data.price,
      origQty: data.origQty,
      side: data.side,
      type: data.type,
      transactTime: data.transactTime || data.updateTime || data.time,
      updateTime: data.updateTime,
      time: data.time,
    };
  }

  async cancelOrder(symbol: string, origClientOrderId: string): Promise<BinanceOrderResponse | null> {
    const fetchImpl = this.customFetch || fetch;
    const queryParams: Record<string, string> = {
      symbol: symbol.replace('/', '').toUpperCase(),
      origClientOrderId,
      recvWindow: String(this.recvWindow),
      timestamp: String(Date.now()),
    };

    const queryStr = new URLSearchParams(queryParams).toString();
    const signature = this.signQuery(queryStr);
    const fullQuery = `${queryStr}&signature=${signature}`;
    const url = `${this.baseUrl}/order?${fullQuery}`;

    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'DELETE',
        headers: {
          'X-MBX-APIKEY': this.apiKey,
        },
      });
    } catch (networkErr: any) {
      const sanitizedErr = this.sanitizeError(networkErr);
      sanitizedErr.name = 'BinanceNetworkError';
      throw sanitizedErr;
    }

    if (!res.ok) {
      let errBody: any = {};
      try {
        errBody = await res.json();
      } catch {
        errBody = { msg: res.statusText };
      }

      if (errBody.code === -2011 || errBody.code === -2013 || res.status === 404) {
        return null;
      }

      if (res.status >= 500) {
        const err = new Error(`Binance 5xx Server Error on Cancel (${res.status}): ${errBody.msg || 'Internal Server Error'}`);
        err.name = 'BinanceServerError';
        throw this.sanitizeError(err);
      }

      const err = new Error(`Binance API Cancel Error (${errBody.code || res.status}): ${errBody.msg || 'Cancel failed'}`);
      err.name = 'BinanceApiError';
      throw this.sanitizeError(err);
    }

    const data = await res.json();
    return {
      symbol: data.symbol,
      orderId: data.orderId,
      clientOrderId: data.clientOrderId,
      status: data.status,
      executedQty: data.executedQty,
      cummulativeQuoteQty: data.cummulativeQuoteQty,
      price: data.price,
      origQty: data.origQty,
      side: data.side,
      type: data.type,
      transactTime: data.transactTime || data.updateTime || data.time,
      updateTime: data.updateTime,
      time: data.time,
    };
  }

  /**
   * Read-only exchange server time for clock synchronization verification
   */
  async getServerTime(): Promise<{ serverTime: number }> {
    const fetchImpl = this.customFetch || fetch;
    const url = `${this.baseUrl}/time`;
    let res: Response;
    try {
      res = await fetchImpl(url, { method: 'GET' });
    } catch (networkErr: any) {
      const sanitizedErr = this.sanitizeError(networkErr);
      sanitizedErr.name = 'BinanceNetworkError';
      throw sanitizedErr;
    }

    if (!res.ok) {
      let errBody: any = {};
      try {
        errBody = await res.json();
      } catch {
        errBody = { msg: res.statusText };
      }
      const err = new Error(`Binance API Error on getServerTime (${errBody.code || res.status}): ${errBody.msg || 'Server time query failed'}`);
      err.name = res.status >= 500 ? 'BinanceServerError' : 'BinanceApiError';
      throw this.sanitizeError(err);
    }
    const data = await res.json();
    return { serverTime: Number(data.serverTime) };
  }

  /**
   * Read-only exchange metadata, trading filters, and symbol active status
   */
  async getExchangeInfo(symbol?: string): Promise<any> {
    const fetchImpl = this.customFetch || fetch;
    let url = `${this.baseUrl}/exchangeInfo`;
    if (symbol) {
      const normalizedSymbol = symbol.replace('/', '').toUpperCase();
      url += `?symbol=${encodeURIComponent(normalizedSymbol)}`;
    }
    let res: Response;
    try {
      res = await fetchImpl(url, { method: 'GET' });
    } catch (networkErr: any) {
      const sanitizedErr = this.sanitizeError(networkErr);
      sanitizedErr.name = 'BinanceNetworkError';
      throw sanitizedErr;
    }

    if (!res.ok) {
      let errBody: any = {};
      try {
        errBody = await res.json();
      } catch {
        errBody = { msg: res.statusText };
      }
      const err = new Error(`Binance API Error on getExchangeInfo (${errBody.code || res.status}): ${errBody.msg || 'Exchange info query failed'}`);
      err.name = res.status >= 500 ? 'BinanceServerError' : 'BinanceApiError';
      throw this.sanitizeError(err);
    }
    return await res.json();
  }

  /**
   * Read-only account information and balances (signed GET request)
   * Strictly enforces read-only access (no settings modification or order submission)
   */
  async getAccountInformation(): Promise<any> {
    const fetchImpl = this.customFetch || fetch;
    const queryParams: Record<string, string> = {
      recvWindow: String(this.recvWindow),
      timestamp: String(Date.now()),
    };

    const queryStr = new URLSearchParams(queryParams).toString();
    const signature = this.signQuery(queryStr);
    const fullQuery = `${queryStr}&signature=${signature}`;
    const url = `${this.baseUrl}/account?${fullQuery}`;

    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'GET',
        headers: {
          'X-MBX-APIKEY': this.apiKey,
        },
      });
    } catch (networkErr: any) {
      const sanitizedErr = this.sanitizeError(networkErr);
      sanitizedErr.name = 'BinanceNetworkError';
      throw sanitizedErr;
    }

    if (!res.ok) {
      let errBody: any = {};
      try {
        errBody = await res.json();
      } catch {
        errBody = { msg: res.statusText };
      }
      const err = new Error(`Binance API Error on getAccountInformation (${errBody.code || res.status}): ${errBody.msg || 'Account info query failed'}`);
      err.name = res.status >= 500 ? 'BinanceServerError' : 'BinanceApiError';
      throw this.sanitizeError(err);
    }
    return await res.json();
  }

  /**
   * Official Binance API key restrictions endpoint (GET /sapi/v1/account/apiRestrictions)
   * Returns specific permissions for the authenticated API key (enableWithdrawals, enableSpotAndMarginTrading, etc.)
   */
  async getApiRestrictions(): Promise<any> {
    const fetchImpl = this.customFetch || fetch;
    const queryParams: Record<string, string> = {
      recvWindow: String(this.recvWindow),
      timestamp: String(Date.now()),
    };

    const queryStr = new URLSearchParams(queryParams).toString();
    const signature = this.signQuery(queryStr);
    const base = this.baseUrl.replace(/\/api\/v3$/, '');
    const url = `${base}/sapi/v1/account/apiRestrictions?${queryStr}&signature=${signature}`;

    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'GET',
        headers: {
          'X-MBX-APIKEY': this.apiKey,
        },
      });
    } catch (networkErr: any) {
      const sanitizedErr = this.sanitizeError(networkErr);
      sanitizedErr.name = 'BinanceNetworkError';
      throw sanitizedErr;
    }

    if (!res.ok) {
      let errBody: any = {};
      try {
        errBody = await res.json();
      } catch {
        errBody = { msg: res.statusText };
      }
      const err = new Error(`Binance API Error on getApiRestrictions (${errBody.code || res.status}): ${errBody.msg || 'API restrictions query failed'}`);
      err.name = res.status >= 500 ? 'BinanceServerError' : 'BinanceApiError';
      (err as any).httpStatus = res.status;
      (err as any).code = errBody.code;
      throw this.sanitizeError(err);
    }
    return await res.json();
  }
}

export type ClientFactory = (creds: { apiKey: string; secretKey: string }, isTestnet: boolean) => BinanceSpotClient;

export class BinanceOrderWorker {
  private isRunning: boolean = false;
  private activeProcessingIntents: Set<string> = new Set();

  constructor(
    private db: BinanceExecutionDbAdapter,
    private masterKeyHex: string,
    private isTestnet: boolean = false,
    private clientFactory?: ClientFactory,
    private isLockLost?: () => boolean
  ) {}

  /**
   * Start Execution Worker Loop
   */
  async start(): Promise<void> {
    this.isRunning = true;
    console.log(`[Binance Order Worker] Started processing trade intents queue (Testnet: ${this.isTestnet})`);

    let loopIteration = 0;
    while (this.isRunning) {
      try {
        await this.processQueueIteration();

        // Stale Crash Recovery Sweep every 30 iterations (~60s)
        loopIteration++;
        if (loopIteration % 30 === 0) {
          await this.reconcileStaleExecutingIntents(120000); // 2 min threshold
        }
      } catch (err: any) {
        console.error('[Binance Order Worker Error] Queue processing failed:', err?.message || err);
      }
      await new Promise(res => setTimeout(res, 2000)); // Poll every 2s
    }
  }

  stop(): void {
    this.isRunning = false;
    console.log('[Binance Order Worker] Worker stopped');
  }

  public getProcessingCount(): number {
    return this.activeProcessingIntents.size;
  }

  /**
   * Process Approved Queue Iteration with Atomic CAS claim
   */
  async processQueueIteration(): Promise<{ processedCount: number }> {
    const intents = await this.db.getApprovedIntentsQueue();
    let processedCount = 0;

    for (const intent of intents) {
      if (this.isLockLost && this.isLockLost()) {
        console.log('[Binance Order Worker] Lock ownership lost; aborting queue iteration.');
        break;
      }
      if (intent.status !== 'APPROVED') {
        continue;
      }
      // Concurrency guard to prevent duplicate processing within identical run loop
      if (this.activeProcessingIntents.has(intent.id)) {
        continue;
      }

      this.activeProcessingIntents.add(intent.id);
      try {
        // 1. Atomic Compare-And-Swap Claim in DB (APPROVED -> EXECUTING)
        const claimed = await this.db.claimIntentAtomic(intent.id);
        if (!claimed) {
          // Another worker instance claimed the intent, or intent status changed
          console.log(`[Binance Order Worker] Intent ${intent.id} could not be claimed atomically (already claimed or non-APPROVED)`);
          continue;
        }

        await this.executeSingleIntent(intent, true); // true = already claimed atomically
        processedCount++;
      } finally {
        this.activeProcessingIntents.delete(intent.id);
      }
    }

    return { processedCount };
  }

  /**
   * Stale Executing Crash Recovery:
   * Periodically scans durable PostgreSQL state for intents stuck in EXECUTING > staleThresholdMs
   * Reconciles against Binance via getOrder(symbol, origClientOrderId).
   * NEVER submits a new order during reconciliation!
   */
  async reconcileStaleExecutingIntents(staleThresholdMs: number = 120000): Promise<{ reconciledCount: number; errors: string[] }> {
    const staleIntents = await this.db.getStaleExecutingIntents(staleThresholdMs);
    let reconciledCount = 0;
    const errors: string[] = [];

    for (const intent of staleIntents) {
      if (this.activeProcessingIntents.has(intent.id)) {
        continue;
      }

      this.activeProcessingIntents.add(intent.id);
      try {
        const res = await this.reconcileSingleStaleIntent(intent);
        if (res.reconciled) {
          reconciledCount++;
        }
      } catch (err: any) {
        errors.push(err?.message || String(err));
      } finally {
        this.activeProcessingIntents.delete(intent.id);
      }
    }

    return { reconciledCount, errors };
  }

  private async reconcileSingleStaleIntent(intent: TradeIntentRecord): Promise<{ reconciled: boolean; status: string }> {
    console.log(`[Binance Order Worker] Reconciling stale EXECUTING intent ${intent.id} (ClientOrderId: ${intent.idempotencyKey})`);

    let apiKey = '';
    let secretKey = '';

    try {
      const creds = await this.db.getBinanceCredentials(intent.userId);
      if (!creds || creds.isActive === false) {
        await this.db.updateIntentStatus(intent.id, 'FAILED');
        await this.db.createAuditLog(intent.userId, 'BINANCE_ORDER_FAILED', intent.id, 'Stale reconciliation: User has no active Binance API credentials');
        return { reconciled: true, status: 'FAILED' };
      }

      const permissions: BinanceKeyPermissions = creds.permissions || { read: true, trade: true, withdraw: false };
      try {
        BinanceCredentialVault.validatePermissions(permissions);
      } catch (permErr: any) {
        await this.db.updateIntentStatus(intent.id, 'FAILED');
        await this.db.createAuditLog(intent.userId, 'BINANCE_SECURITY_REJECTION', intent.id, this.sanitizeMessage(permErr.message));
        return { reconciled: true, status: 'FAILED' };
      }

      const apiKeyPayload = this.normalizePayload(creds.encryptedApiKey, creds.iv, creds.authTag);
      const secretKeyPayload = this.normalizePayload(creds.encryptedSecretKey, creds.iv, creds.authTag);

      apiKey = await BinanceCredentialVault.decrypt(apiKeyPayload, this.masterKeyHex, intent.userId, creds.id, this.db);
      secretKey = await BinanceCredentialVault.decrypt(secretKeyPayload, this.masterKeyHex, intent.userId, creds.id, this.db);

      const client = this.clientFactory
        ? this.clientFactory({ apiKey, secretKey }, this.isTestnet)
        : new RealBinanceSpotClient({ apiKey, secretKey, isTestnet: this.isTestnet });

      const normalizedSymbol = intent.symbol.replace('/', '').toUpperCase();

      // Query exchange status using origClientOrderId (NEVER submits a new order!)
      let queriedOrder: BinanceOrderResponse | null = null;
      try {
        queriedOrder = await client.getOrder(normalizedSymbol, intent.idempotencyKey);
      } catch (queryErr: any) {
        console.warn(`[Binance Order Worker] Query error during stale reconciliation for ${intent.id}:`, this.sanitizeMessage(queryErr?.message || '', apiKey, secretKey));
        // On network/server error, do NOT fail or submit new order — remain in EXECUTING to be retried in next sweep
        return { reconciled: false, status: 'EXECUTING' };
      }

      // FILLED: Order fully executed — record fill and mark EXECUTED
      if (queriedOrder && queriedOrder.status === 'FILLED') {
        const executedQty = typeof queriedOrder.executedQty === 'string' ? parseFloat(queriedOrder.executedQty) : queriedOrder.executedQty;
        const cummulativeQuoteQty = typeof queriedOrder.cummulativeQuoteQty === 'string'
          ? parseFloat(queriedOrder.cummulativeQuoteQty)
          : (queriedOrder.cummulativeQuoteQty || executedQty * (intent.price || 1.0));

        await this.db.recordOrderFill({
          intentId: intent.id,
          exchangeOrderId: String(queriedOrder.orderId),
          symbol: intent.symbol,
          status: queriedOrder.status,
          executedQty,
          cummulativeQuoteQty,
        });

        await this.db.updateIntentStatus(intent.id, 'EXECUTED');
        await this.db.createAuditLog(
          intent.userId,
          'BINANCE_ORDER_RECONCILED',
          intent.id,
          `Stale Crash Recovery: Order recovered via origClientOrderId ${intent.idempotencyKey}, Binance Order ID: ${queriedOrder.orderId}`
        );

        return { reconciled: true, status: 'EXECUTED' };
      }

      // NEW: Order accepted by exchange matching engine but NOT yet filled — remain EXECUTING for next sweep
      if (queriedOrder && queriedOrder.status === 'NEW') {
        console.log(`[Binance Order Worker] Stale intent ${intent.id} has exchange status NEW (open order, not filled) — retaining EXECUTING for next reconciliation sweep`);
        return { reconciled: false, status: 'EXECUTING' };
      }

      // PARTIALLY_FILLED: Order partially executed, still open on exchange — persist fill snapshot, remain EXECUTING for next sweep
      if (queriedOrder && queriedOrder.status === 'PARTIALLY_FILLED') {
        const executedQty = typeof queriedOrder.executedQty === 'string' ? parseFloat(queriedOrder.executedQty) : queriedOrder.executedQty;
        const cummulativeQuoteQty = typeof queriedOrder.cummulativeQuoteQty === 'string'
          ? parseFloat(queriedOrder.cummulativeQuoteQty)
          : (queriedOrder.cummulativeQuoteQty || executedQty * (intent.price || 1.0));

        await this.db.recordOrderFill({
          intentId: intent.id,
          exchangeOrderId: String(queriedOrder.orderId),
          symbol: intent.symbol,
          status: queriedOrder.status,
          executedQty,
          cummulativeQuoteQty,
        });

        await this.db.createAuditLog(
          intent.userId,
          'BINANCE_ORDER_PARTIAL_FILL_SNAPSHOT',
          intent.id,
          `Stale Crash Recovery: PARTIALLY_FILLED snapshot recorded (executedQty=${executedQty}) — order still open, retaining EXECUTING`
        );

        console.log(`[Binance Order Worker] Stale intent ${intent.id} has exchange status PARTIALLY_FILLED (executedQty=${executedQty}) — fill snapshot recorded, retaining EXECUTING for next reconciliation sweep`);
        return { reconciled: false, status: 'EXECUTING' };
      }

      if (queriedOrder && (queriedOrder.status === 'CANCELED' || queriedOrder.status === 'REJECTED' || queriedOrder.status === 'EXPIRED')) {
        await this.db.updateIntentStatus(intent.id, 'FAILED');
        await this.db.createAuditLog(
          intent.userId,
          'BINANCE_ORDER_FAILED',
          intent.id,
          `Stale Crash Recovery: Order reached exchange but was ${queriedOrder.status}`
        );
        return { reconciled: true, status: 'FAILED' };
      }

      // If queriedOrder is null (HTTP 404 / code -2013 Order does not exist):
      // The order never reached the Binance matching engine before crash.
      await this.db.updateIntentStatus(intent.id, 'FAILED');
      await this.db.createAuditLog(
        intent.userId,
        'BINANCE_ORDER_FAILED',
        intent.id,
        `Stale Crash Recovery: Order was never registered on exchange matching engine (origClientOrderId: ${intent.idempotencyKey})`
      );
      return { reconciled: true, status: 'FAILED' };

    } catch (err: any) {
      const cleanErr = this.sanitizeMessage(err?.message || 'Stale reconciliation error', apiKey, secretKey);
      console.error(`[Binance Order Worker] Stale reconciliation exception for ${intent.id}:`, cleanErr);
      return { reconciled: false, status: 'EXECUTING' };
    }
  }

  /**
   * Helper to normalize EncryptedPayload from string or object
   */
  private normalizePayload(raw: any, ivFallback?: string, authTagFallback?: string): EncryptedPayload {
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.encryptedData && parsed.iv && parsed.authTag) {
          return parsed;
        }
      } catch {
        // Not a JSON string
      }
      return {
        encryptedData: raw,
        iv: ivFallback || '',
        authTag: authTagFallback || '',
      };
    }
    return raw;
  }

  private findMatchingKillSwitch(activeKillSwitches: any[], intent: TradeIntentRecord): any | null {
    return (activeKillSwitches || []).find((ks: any) => {
      if (!ks.isActive) return false;
      if (ks.scope === 'GLOBAL') return true;
      if (ks.scope === 'USER' && (ks.targetId === intent.userId || ks.targetId?.toLowerCase() === intent.userId.toLowerCase())) return true;
      if (
        ks.scope === 'TOKEN' &&
        ks.targetId &&
        (ks.targetId.toLowerCase() === intent.symbol.toLowerCase() ||
         ks.targetId.toLowerCase() === intent.symbol.replace('/', '').toLowerCase())
      ) {
        return true;
      }
      return false;
    }) || null;
  }

  private sanitizeMessage(msg: string, apiKey?: string, secretKey?: string): string {
    let clean = msg || '';
    if (apiKey) {
      clean = clean.split(apiKey).join('[REDACTED_API_KEY]');
    }
    if (secretKey) {
      clean = clean.split(secretKey).join('[REDACTED_SECRET_KEY]');
    }
    clean = clean.replace(/([a-f0-9]{32,})/gi, '[REDACTED]');
    clean = clean.replace(/signature=[a-f0-9]{64}/gi, 'signature=[REDACTED_SIGNATURE]');
    return clean;
  }

  /**
   * Execute single intent with strict atomic claim, permission, signing, and reconciliation guards
   */
  async executeSingleIntent(
    intent: TradeIntentRecord,
    isAlreadyClaimed: boolean = false
  ): Promise<{ success: boolean; status: string; exchangeOrderId?: string; error?: string }> {
    console.log(`[Binance Order Worker] Executing intent ${intent.id} for symbol ${intent.symbol} (${intent.side})`);

    // 1. Atomic Compare-And-Swap Claim in DB if not already claimed
    if (!isAlreadyClaimed) {
      const claimed = await this.db.claimIntentAtomic(intent.id);
      if (!claimed) {
        const reason = `CLAIM_REJECTED: Intent ${intent.id} could not be claimed atomically (already claimed or status is not APPROVED)`;
        console.warn(`[Binance Order Worker] ${reason}`);
        return { success: false, status: 'CLAIM_REJECTED', error: reason };
      }
    }

    let apiKey = '';
    let secretKey = '';
    let dispatchAttempted = false;

    try {
      // 1.5. Active Kill Switch Pre-Execution Check (Global, User, Token) — mandatory fail-closed
      const activeKillSwitches = await this.db.getActiveKillSwitches();
      const haltedSwitch = this.findMatchingKillSwitch(activeKillSwitches, intent);

      if (haltedSwitch) {
        const reason = `KILL_SWITCH_BLOCKED: Trade execution halted by active ${haltedSwitch.scope} kill switch (${haltedSwitch.reason || 'Emergency halt'})`;
        console.warn(`[Binance Order Worker] ${reason} for intent ${intent.id}`);
        await this.db.updateIntentStatus(intent.id, 'CANCELLED', `KILL_SWITCH_ACTIVE_AT_EXECUTION: ${reason}`);
        await this.db.createAuditLog(intent.userId, 'INTENT_CANCELLED_BY_KILL_SWITCH', intent.id, reason);
        return { success: false, status: 'CANCELLED', error: reason };
      }

      // 2. Fetch Binance credentials for user
      const creds = await this.db.getBinanceCredentials(intent.userId);
      if (!creds || creds.isActive === false) {
        const reason = `BINANCE_CREDS_NOT_FOUND: User ${intent.userId} has no active Binance API credentials registered`;
        await this.db.updateIntentStatus(intent.id, 'FAILED');
        await this.db.createAuditLog(intent.userId, 'BINANCE_ORDER_FAILED', intent.id, reason);
        return { success: false, status: 'FAILED', error: reason };
      }

      // 3. Validate permissions (Fail-closed on withdrawal permission or missing trade/read)
      const permissions: BinanceKeyPermissions = creds.permissions || { read: true, trade: true, withdraw: false };
      try {
        BinanceCredentialVault.validatePermissions(permissions);
      } catch (permErr: any) {
        const reason = `WITHDRAWAL_PERMISSION_PROHIBITED: ${permErr.message}`;
        await this.db.updateIntentStatus(intent.id, 'FAILED');
        await this.db.createAuditLog(intent.userId, 'BINANCE_SECURITY_REJECTION', intent.id, this.sanitizeMessage(reason));
        return { success: false, status: 'FAILED', error: reason };
      }

      // 4. Decrypt API Key & Secret Key with mandatory audit log
      const apiKeyPayload = this.normalizePayload(creds.encryptedApiKey, creds.iv, creds.authTag);
      const secretKeyPayload = this.normalizePayload(creds.encryptedSecretKey, creds.iv, creds.authTag);

      apiKey = await BinanceCredentialVault.decrypt(apiKeyPayload, this.masterKeyHex, intent.userId, creds.id, this.db);
      secretKey = await BinanceCredentialVault.decrypt(secretKeyPayload, this.masterKeyHex, intent.userId, creds.id, this.db);

      // 5. Instantiate Binance Client
      const client = this.clientFactory
        ? this.clientFactory({ apiKey, secretKey }, this.isTestnet)
        : new RealBinanceSpotClient({ apiKey, secretKey, isTestnet: this.isTestnet });

      const normalizedSymbol = intent.symbol.replace('/', '').toUpperCase();

      // 5.5. Pre-dispatch Kill-Switch Re-verification (Best-Effort Emergency Halt)
      const preDispatchKillSwitches = await this.db.getActiveKillSwitches();
      const preDispatchHalt = this.findMatchingKillSwitch(preDispatchKillSwitches, intent);
      if (preDispatchHalt) {
        const reason = `PRE_DISPATCH_KILL_SWITCH_BLOCKED: Trade execution halted before submission by active ${preDispatchHalt.scope} kill switch (${preDispatchHalt.reason || 'Emergency halt'})`;
        console.warn(`[Binance Order Worker] ${reason} for intent ${intent.id}`);
        await this.db.updateIntentStatus(intent.id, 'CANCELLED', `KILL_SWITCH_ACTIVE_PRE_DISPATCH: ${reason}`);
        await this.db.createAuditLog(intent.userId, 'INTENT_CANCELLED_BY_KILL_SWITCH', intent.id, reason);
        return { success: false, status: 'CANCELLED', error: reason };
      }

      // 5.6. Lifecycle & Lock Loss Guard: Prevent dispatch if advisory lock ownership was lost
      if (this.isLockLost && this.isLockLost()) {
        const reason = 'DISPATCH_ABORTED: Advisory lock ownership lost prior to order dispatch';
        console.warn(`[Binance Order Worker] ${reason} for intent ${intent.id}`);
        // Invariant: Retain EXECUTING in DB so reconciler can recover; do not call newOrder
        return { success: false, status: 'EXECUTING', error: reason };
      }

      // 6. Submit Order to Binance with Idempotency Key (newClientOrderId)
      let orderRes: BinanceOrderResponse;
      try {
        dispatchAttempted = true;
        orderRes = await client.newOrder({
          symbol: normalizedSymbol,
          side: intent.side,
          type: intent.type,
          quantity: intent.quantity,
          price: intent.price,
          newClientOrderId: intent.idempotencyKey,
        });
      } catch (submitErr: any) {
        const classified = classifyBinanceError(submitErr);

        if (classified.classification === 'DEFINITIVE_REJECTION') {
          // Pre-trade validation failure: guaranteed rejected prior to execution
          const cleanErr = this.sanitizeMessage(submitErr.message || 'Order rejected by exchange pre-trade filter', apiKey, secretKey);
          await this.db.updateIntentStatus(intent.id, 'FAILED');
          await this.db.createAuditLog(intent.userId, 'BINANCE_ORDER_FAILED', intent.id, cleanErr);
          return { success: false, status: 'FAILED', error: cleanErr };
        }

        // Both 'DUPLICATE_CLIENT_ORDER_ID' and 'AMBIGUOUS_OUTCOME' require idempotent reconciliation query.
        // Invariant: Strictly zero new client order IDs, zero resubmissions.
        console.warn(`[Binance Order Worker] Ambiguous or duplicate submission exception for ${intent.id} (${classified.classification}: ${this.sanitizeMessage(submitErr.message, apiKey, secretKey)}). Performing idempotent reconciliation query...`);

          // Check if kill switch is active during this ambiguous submission recovery
          const activeKillSwitches = await this.db.getActiveKillSwitches();
          const ksHalt = this.findMatchingKillSwitch(activeKillSwitches, intent);
          if (ksHalt) {
            console.warn(`[Binance Order Worker] Kill switch active during ambiguous submission for intent ${intent.id}. Attempting emergency cancellation.`);
            let cancelRes: BinanceOrderResponse | null = null;
            if (typeof client.cancelOrder === 'function') {
              try {
                cancelRes = await client.cancelOrder(normalizedSymbol, intent.idempotencyKey);
              } catch (cErr: any) {
                console.error(`[Binance Order Worker] Emergency cancellation on timeout failed:`, this.sanitizeMessage(cErr?.message || '', apiKey, secretKey));
              }
            }
            if (cancelRes && cancelRes.status === 'CANCELED') {
              const executedQty = typeof cancelRes.executedQty === 'string' ? parseFloat(cancelRes.executedQty) : (cancelRes.executedQty || 0);
              const cummulativeQuoteQty = typeof cancelRes.cummulativeQuoteQty === 'string'
                ? parseFloat(cancelRes.cummulativeQuoteQty)
                : (cancelRes.cummulativeQuoteQty || executedQty * (intent.price || 1.0));
              await this.db.recordOrderFill({
                intentId: intent.id,
                exchangeOrderId: String(cancelRes.orderId),
                symbol: intent.symbol,
                status: 'CANCELED',
                executedQty,
                cummulativeQuoteQty,
              });
              await this.db.updateIntentStatus(intent.id, 'CANCELLED', `EMERGENCY_HALT: ${ksHalt.reason || 'Kill switch activated'}`);
              await this.db.createAuditLog(
                intent.userId,
                'BINANCE_ORDER_CANCELLED_BY_KILL_SWITCH',
                intent.id,
                `Exchange confirmed order cancellation following ambiguous submission (status: CANCELED, executedQty: ${executedQty})`
              );
              return { success: false, status: 'CANCELLED', error: 'Order cancelled on exchange due to active kill switch' };
            }
          }

          let queriedOrder: BinanceOrderResponse | null = null;
          let queryFailed = false;
          let queryErrMsg = '';

          try {
            queriedOrder = await client.getOrder(normalizedSymbol, intent.idempotencyKey);
          } catch (reconcileErr: any) {
            queryFailed = true;
            queryErrMsg = this.sanitizeMessage(reconcileErr?.message || '', apiKey, secretKey);
            console.error(`[Binance Order Worker] Reconciliation query failed for ${intent.id}:`, queryErrMsg);
          }

          if (queriedOrder && queriedOrder.status === 'FILLED') {
            const executedQty = typeof queriedOrder.executedQty === 'string' ? parseFloat(queriedOrder.executedQty) : queriedOrder.executedQty;
            const cummulativeQuoteQty = typeof queriedOrder.cummulativeQuoteQty === 'string'
              ? parseFloat(queriedOrder.cummulativeQuoteQty)
              : (queriedOrder.cummulativeQuoteQty || executedQty * (intent.price || 1.0));

            await this.db.recordOrderFill({
              intentId: intent.id,
              exchangeOrderId: String(queriedOrder.orderId),
              symbol: intent.symbol,
              status: queriedOrder.status,
              executedQty,
              cummulativeQuoteQty,
            });

            await this.db.updateIntentStatus(intent.id, 'EXECUTED');
            const auditAction = ksHalt ? 'BINANCE_ORDER_EXECUTED_DESPITE_KILL_SWITCH' : 'BINANCE_ORDER_RECONCILED';
            await this.db.createAuditLog(
              intent.userId,
              auditAction,
              intent.id,
              `Order recovered via origClientOrderId ${intent.idempotencyKey}, Binance Order ID: ${queriedOrder.orderId}`
            );

            return { success: true, status: 'EXECUTED', exchangeOrderId: String(queriedOrder.orderId) };
          }

          if (queriedOrder && queriedOrder.status === 'NEW') {
            if (ksHalt) {
              const unresReason = `Kill switch active during ambiguous submission; order status on exchange is NEW and emergency cancel could not be confirmed; retaining EXECUTING for reconciliation`;
              console.warn(`[Binance Order Worker] ${unresReason} for intent ${intent.id}`);
              await this.db.createAuditLog(
                intent.userId,
                'BINANCE_KILL_SWITCH_CANCEL_UNRESOLVED',
                intent.id,
                unresReason
              );
              return { success: false, status: 'EXECUTING', error: unresReason };
            }
            console.log(`[Binance Order Worker] Ambiguous submission reconciliation: intent ${intent.id} has exchange status NEW (open, not yet filled) — retaining EXECUTING for stale reconciliation sweep`);
            return { success: false, status: 'EXECUTING' };
          }

          if (queriedOrder && queriedOrder.status === 'PARTIALLY_FILLED') {
            const partialQty = typeof queriedOrder.executedQty === 'string' ? parseFloat(queriedOrder.executedQty) : queriedOrder.executedQty;
            const partialQuote = typeof queriedOrder.cummulativeQuoteQty === 'string'
              ? parseFloat(queriedOrder.cummulativeQuoteQty)
              : (queriedOrder.cummulativeQuoteQty || partialQty * (intent.price || 1.0));

            await this.db.recordOrderFill({
              intentId: intent.id,
              exchangeOrderId: String(queriedOrder.orderId),
              symbol: intent.symbol,
              status: queriedOrder.status,
              executedQty: partialQty,
              cummulativeQuoteQty: partialQuote,
            });

            if (ksHalt) {
              const unresReason = `Kill switch active during ambiguous submission; order is PARTIALLY_FILLED (executedQty=${partialQty}) and cancellation unconfirmed; retaining EXECUTING for reconciliation`;
              console.warn(`[Binance Order Worker] ${unresReason} for intent ${intent.id}`);
              await this.db.createAuditLog(
                intent.userId,
                'BINANCE_KILL_SWITCH_CANCEL_UNRESOLVED',
                intent.id,
                unresReason
              );
              return { success: false, status: 'EXECUTING', error: unresReason };
            }

            await this.db.createAuditLog(
              intent.userId,
              'BINANCE_ORDER_PARTIAL_FILL_SNAPSHOT',
              intent.id,
              `Ambiguous submission reconciliation: PARTIALLY_FILLED snapshot recorded (executedQty=${partialQty}) — retaining EXECUTING`
            );

            console.log(`[Binance Order Worker] Ambiguous submission reconciliation: intent ${intent.id} PARTIALLY_FILLED (executedQty=${partialQty}) — retaining EXECUTING`);
            return { success: false, status: 'EXECUTING' };
          }

          if (queriedOrder && (queriedOrder.status === 'CANCELED' || queriedOrder.status === 'REJECTED' || queriedOrder.status === 'EXPIRED')) {
            const executedQty = typeof queriedOrder.executedQty === 'string' ? parseFloat(queriedOrder.executedQty) : (queriedOrder.executedQty || 0);
            const cummulativeQuoteQty = typeof queriedOrder.cummulativeQuoteQty === 'string'
              ? parseFloat(queriedOrder.cummulativeQuoteQty)
              : (queriedOrder.cummulativeQuoteQty || executedQty * (intent.price || 1.0));

            await this.db.recordOrderFill({
              intentId: intent.id,
              exchangeOrderId: String(queriedOrder.orderId),
              symbol: intent.symbol,
              status: queriedOrder.status,
              executedQty,
              cummulativeQuoteQty,
              audit: {
                actorId: intent.userId,
                action: ksHalt ? 'BINANCE_ORDER_CANCELLED_BY_KILL_SWITCH' : (queriedOrder.status === 'REJECTED' ? 'BINANCE_ORDER_FAILED' : 'BINANCE_ORDER_CANCELLED'),
                reason: `Ambiguous submission resolved: Order reached exchange but was ${queriedOrder.status} (executedQty: ${executedQty})`,
              },
            });

            const termStatus = ksHalt ? 'CANCELLED' : (queriedOrder.status === 'REJECTED' ? 'FAILED' : 'CANCELLED');
            return { success: false, status: termStatus, error: `Order was ${queriedOrder.status} on exchange` };
          }

          // Ambiguous submission where query returned null or query failed:
          // CRITICAL: Retain EXECUTING, log appropriate escalation evidence (DO NOT mark FAILED or CANCELLED)
          if (ksHalt) {
            const unresReason = queryFailed
              ? `Kill switch active during ambiguous submission but reconciliation query failed (${queryErrMsg}); retaining EXECUTING for sweep`
              : `Kill switch active during ambiguous submission but order not found on immediate query (-2013 / 404); cancellation unconfirmed, retaining EXECUTING for sweep`;
            console.warn(`[Binance Order Worker] ${unresReason} for intent ${intent.id}`);
            await this.db.createAuditLog(
              intent.userId,
              'BINANCE_KILL_SWITCH_CANCEL_UNRESOLVED',
              intent.id,
              unresReason
            );
            return { success: false, status: 'EXECUTING', error: unresReason };
          }

          const ambigReason = queryFailed
            ? `Query failed after ambiguous submission (${queryErrMsg}); retaining EXECUTING`
            : `Order not found on immediate query (-2013 / 404) after ambiguous submission; retaining EXECUTING for sweep verification`;
          console.warn(`[Binance Order Worker] ${ambigReason} for intent ${intent.id}`);
          await this.db.createAuditLog(
            intent.userId,
            'BINANCE_ORDER_SUBMISSION_AMBIGUOUS',
            intent.id,
            ambigReason
          );
          return { success: false, status: 'EXECUTING', error: ambigReason };
      }

      // 6.5. Post-dispatch Kill-Switch Verification (Best-Effort Emergency Halt)
      const postDispatchKillSwitches = await this.db.getActiveKillSwitches();
      const postDispatchHalt = this.findMatchingKillSwitch(postDispatchKillSwitches, intent);
      if (postDispatchHalt) {
        console.warn(`[Binance Order Worker] Kill switch activated during in-flight dispatch for intent ${intent.id}. Performing best-effort emergency cancellation.`);
        let cancelRes: BinanceOrderResponse | null = null;
        let queryRes: BinanceOrderResponse | null = null;

        if (typeof client.cancelOrder === 'function') {
          try {
            cancelRes = await client.cancelOrder(normalizedSymbol, intent.idempotencyKey);
          } catch (cancelErr: any) {
            console.error(`[Binance Order Worker] Emergency cancellation request failed:`, this.sanitizeMessage(cancelErr?.message || '', apiKey, secretKey));
          }
        }

        // If cancelOrder did not return confirmed CANCELED or FILLED, query exchange
        if (!cancelRes || (cancelRes.status !== 'CANCELED' && cancelRes.status !== 'FILLED')) {
          try {
            queryRes = await client.getOrder(normalizedSymbol, intent.idempotencyKey);
          } catch (qErr: any) {
            console.warn(`[Binance Order Worker] Post-cancel query failed for ${intent.id}:`, this.sanitizeMessage(qErr?.message || '', apiKey, secretKey));
          }
        }

        const resolvedOrder = cancelRes || queryRes;

        // Case D: Exchange reports order already FILLED
        if (resolvedOrder && resolvedOrder.status === 'FILLED') {
          const executedQty = typeof resolvedOrder.executedQty === 'string' ? parseFloat(resolvedOrder.executedQty) : resolvedOrder.executedQty;
          const cummulativeQuoteQty = typeof resolvedOrder.cummulativeQuoteQty === 'string'
            ? parseFloat(resolvedOrder.cummulativeQuoteQty)
            : (resolvedOrder.cummulativeQuoteQty || executedQty * (intent.price || 1.0));

          await this.db.recordOrderFill({
            intentId: intent.id,
            exchangeOrderId: String(resolvedOrder.orderId),
            symbol: intent.symbol,
            status: 'FILLED',
            executedQty,
            cummulativeQuoteQty,
          });

          await this.db.updateIntentStatus(intent.id, 'EXECUTED');
          await this.db.createAuditLog(
            intent.userId,
            'BINANCE_ORDER_EXECUTED_DESPITE_KILL_SWITCH',
            intent.id,
            `Order was already FILLED on exchange before emergency cancel could take effect (orderId: ${resolvedOrder.orderId})`
          );
          return { success: true, status: 'EXECUTED', exchangeOrderId: String(resolvedOrder.orderId) };
        }

        // Case B: Binance cancellation explicitly confirmed
        if (resolvedOrder && resolvedOrder.status === 'CANCELED') {
          const executedQty = typeof resolvedOrder.executedQty === 'string' ? parseFloat(resolvedOrder.executedQty) : (resolvedOrder.executedQty || 0);
          const cummulativeQuoteQty = typeof resolvedOrder.cummulativeQuoteQty === 'string'
            ? parseFloat(resolvedOrder.cummulativeQuoteQty)
            : (resolvedOrder.cummulativeQuoteQty || executedQty * (intent.price || 1.0));

          await this.db.recordOrderFill({
            intentId: intent.id,
            exchangeOrderId: String(resolvedOrder.orderId),
            symbol: intent.symbol,
            status: 'CANCELED',
            executedQty,
            cummulativeQuoteQty,
          });

          await this.db.updateIntentStatus(intent.id, 'CANCELLED', `EMERGENCY_HALT: ${postDispatchHalt.reason || 'Kill switch activated during dispatch'}`);
          await this.db.createAuditLog(
            intent.userId,
            'INTENT_CANCELLED_BY_KILL_SWITCH',
            intent.id,
            `Emergency halt applied post-dispatch: ${postDispatchHalt.reason || 'Kill switch activated during dispatch'} (status: CANCELED, executedQty: ${executedQty})`
          );
          return {
            success: false,
            status: 'CANCELLED',
            exchangeOrderId: String(resolvedOrder.orderId),
            error: `Order cancelled on exchange by active kill switch (${postDispatchHalt.scope})`
          };
        }

        // Case C: Cancellation unresolved or exchange unavailable (cancelOrder timed out/failed and order is NEW/PARTIALLY_FILLED or query failed)
        // CRITICAL INVARIANT: Retain EXECUTING, log escalation evidence, do NOT mark CANCELLED!
        if (resolvedOrder && resolvedOrder.status === 'PARTIALLY_FILLED') {
          const partialQty = typeof resolvedOrder.executedQty === 'string' ? parseFloat(resolvedOrder.executedQty) : resolvedOrder.executedQty;
          const partialQuote = typeof resolvedOrder.cummulativeQuoteQty === 'string'
            ? parseFloat(resolvedOrder.cummulativeQuoteQty)
            : (resolvedOrder.cummulativeQuoteQty || partialQty * (intent.price || 1.0));

          await this.db.recordOrderFill({
            intentId: intent.id,
            exchangeOrderId: String(resolvedOrder.orderId),
            symbol: intent.symbol,
            status: 'PARTIALLY_FILLED',
            executedQty: partialQty,
            cummulativeQuoteQty: partialQuote,
          });
        }

        const unresReason = `Kill switch activated during dispatch but emergency cancellation unconfirmed on exchange (status: ${resolvedOrder?.status || 'UNKNOWN'}); retaining EXECUTING for reconciliation sweep`;
        console.warn(`[Binance Order Worker] ${unresReason} for intent ${intent.id}`);
        await this.db.createAuditLog(
          intent.userId,
          'BINANCE_KILL_SWITCH_CANCEL_UNRESOLVED',
          intent.id,
          unresReason
        );
        return {
          success: false,
          status: 'EXECUTING',
          exchangeOrderId: resolvedOrder ? String(resolvedOrder.orderId) : String(orderRes.orderId),
          error: unresReason,
        };
      }

      // 7. Order Successfully Executed
      const executedQty = typeof orderRes.executedQty === 'string' ? parseFloat(orderRes.executedQty) : orderRes.executedQty;
      const cummulativeQuoteQty = typeof orderRes.cummulativeQuoteQty === 'string'
        ? parseFloat(orderRes.cummulativeQuoteQty)
        : (orderRes.cummulativeQuoteQty || executedQty * (intent.price || 1.0));

      await this.db.recordOrderFill({
        intentId: intent.id,
        exchangeOrderId: String(orderRes.orderId),
        symbol: intent.symbol,
        status: orderRes.status || 'FILLED',
        executedQty,
        cummulativeQuoteQty,
      });

      await this.db.updateIntentStatus(intent.id, 'EXECUTED');
      await this.db.createAuditLog(
        intent.userId,
        'BINANCE_ORDER_EXECUTED',
        intent.id,
        `Symbol: ${intent.symbol}, Side: ${intent.side}, Qty: ${executedQty}, ExchangeOrderId: ${orderRes.orderId}`
      );

      console.log(`[Binance Order Worker] Intent ${intent.id} successfully EXECUTED!`);
      return { success: true, status: 'EXECUTED', exchangeOrderId: String(orderRes.orderId) };

    } catch (err: any) {
      const cleanErr = this.sanitizeMessage(err?.message || 'Execution error', apiKey, secretKey);
      console.error(`[Binance Order Worker Error] Intent ${intent.id} execution failed:`, cleanErr);

      if (dispatchAttempted) {
        // Invariant: NEVER mark FAILED on post-dispatch exceptions. External side effect may be in-flight.
        // Retain EXECUTING for reconciliation sweep verification.
        console.warn(`[Binance Order Worker] Post-dispatch exception occurred for ${intent.id}; retaining EXECUTING for reconciliation`);
        await this.db.createAuditLog(
          intent.userId,
          'BINANCE_ORDER_DISPATCH_EXCEPTION',
          intent.id,
          `Post-dispatch exception: ${cleanErr}. Retaining EXECUTING for reconciliation.`
        );
        return { success: false, status: 'EXECUTING', error: cleanErr };
      }

      await this.db.updateIntentStatus(intent.id, 'FAILED');
      await this.db.createAuditLog(intent.userId, 'BINANCE_ORDER_FAILED', intent.id, cleanErr);
      return { success: false, status: 'FAILED', error: cleanErr };
    }
  }
}
