/**
 * packages/trading/bybit-vault.ts
 *
 * Stateless Bybit V5 Spot/Perp Read-Only Live Ping & No-Withdrawal Permission Verifier.
 * Implements `CexExecutionAdapterContract` from `packages/providers/registry.ts`.
 * - Uses Bybit V5 HMAC-SHA256 signing (`GET /v5/user/query-api`, 6s timeout).
 * - NEVER logs or echoes raw API keys or secret keys.
 * - Flags `WITHDRAWAL_ENABLED_ON_EXCHANGE` if Wallet withdrawal permissions are enabled.
 */

import crypto from 'crypto';
import type { CexExecutionAdapterContract } from '../providers/registry';
import { resolveBybitBrokerReferer } from './fee-monetization';

export interface BybitLivePingResult {
  connected: boolean;
  environment: 'TESTNET' | 'MAINNET';
  canTrade: boolean;
  canWithdraw: boolean;
  readOnly?: boolean;
  latencyMs: number;
  securityWarning?: 'WITHDRAWAL_ENABLED_ON_EXCHANGE';
  error?: string;
}

export interface BybitSpotOrderResult {
  submitted: boolean;
  environment: 'TESTNET' | 'MAINNET';
  orderId?: string;
  orderLinkId?: string;
  latencyMs: number;
  error?: string;
}

/**
 * Parses a stored Bybit credential pair formatted as `apiKey:secretKey` or JSON `{"apiKey","secretKey"}`.
 */
export function parseBybitKeyPair(raw: string): { apiKey: string; secretKey: string } {
  const trimmed = (raw || '').trim();
  if (!trimmed) {
    throw new Error('INVALID_BYBIT_CREDENTIAL: Expected "apiKey:secretKey" format.');
  }

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const apiKey = typeof parsed?.apiKey === 'string' ? parsed.apiKey.trim() : '';
      const secretKey = typeof parsed?.secretKey === 'string' ? parsed.secretKey.trim() : '';
      if (apiKey.length >= 8 && secretKey.length >= 8) {
        return { apiKey, secretKey };
      }
    } catch {
      throw new Error('INVALID_BYBIT_CREDENTIAL: Malformed JSON credential pair.');
    }
  }

  const sepIdx = trimmed.indexOf(':');
  if (sepIdx <= 0) {
    throw new Error('INVALID_BYBIT_CREDENTIAL: Expected "apiKey:secretKey" format.');
  }
  const apiKey = trimmed.slice(0, sepIdx).trim();
  const secretKey = trimmed.slice(sepIdx + 1).trim();
  if (apiKey.length < 8 || secretKey.length < 8) {
    throw new Error('INVALID_BYBIT_CREDENTIAL: Both apiKey and secretKey must be at least 8 characters.');
  }
  return { apiKey, secretKey };
}

/**
 * Computes Bybit V5 HMAC-SHA256 signature for GET requests:
 * `HMAC_SHA256(secretKey, timestamp + apiKey + recvWindow + queryString)`
 */
export function signBybitV5Get(params: {
  timestamp: string;
  apiKey: string;
  secretKey: string;
  recvWindow?: string;
  queryString?: string;
}): string {
  const recvWindow = params.recvWindow || '5000';
  const queryString = params.queryString || '';
  const prehash = `${params.timestamp}${params.apiKey}${recvWindow}${queryString}`;
  return crypto.createHmac('sha256', params.secretKey).update(prehash).digest('hex');
}

/**
 * Computes Bybit V5 HMAC-SHA256 signature for POST requests:
 * `HMAC_SHA256(secretKey, timestamp + apiKey + recvWindow + rawJsonBody)`
 */
export function signBybitV5Post(params: {
  timestamp: string;
  apiKey: string;
  secretKey: string;
  recvWindow?: string;
  rawBody: string;
}): string {
  const recvWindow = params.recvWindow || '5000';
  const prehash = `${params.timestamp}${params.apiKey}${recvWindow}${params.rawBody}`;
  return crypto.createHmac('sha256', params.secretKey).update(prehash).digest('hex');
}

/**
 * Stateless Single-Shot Bybit V5 Spot Order Execution (`POST /v5/order/create`, 6s timeout).
 * - NEVER logs or echoes raw API keys or secret keys.
 * - Normalizes symbol (strips `/` separator) and uses `marketUnit: 'baseCoin'` for Spot Market orders.
 */
export async function submitBybitSpotOrder(params: {
  apiKey: string;
  secretKey: string;
  environment: 'TESTNET' | 'MAINNET';
  symbol: string;
  side: 'BUY' | 'SELL';
  orderType: 'MARKET' | 'LIMIT';
  qty: number;
  price?: number;
  orderLinkId: string;
  brokerReferer?: string;
  fetchImpl?: typeof fetch;
}): Promise<BybitSpotOrderResult> {
  const start = Date.now();
  const baseUrl =
    params.environment === 'MAINNET' ? 'https://api.bybit.com' : 'https://api-testnet.bybit.com';
  const normalizedSymbol = params.symbol.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  const payload: Record<string, string> = {
    category: 'spot',
    symbol: normalizedSymbol,
    side: params.side === 'SELL' ? 'Sell' : 'Buy',
    orderType: params.orderType === 'LIMIT' ? 'Limit' : 'Market',
    qty: String(params.qty),
    orderLinkId: params.orderLinkId.slice(0, 36),
  };
  if (params.orderType === 'MARKET') {
    payload.marketUnit = 'baseCoin';
  } else if (params.price !== undefined && Number.isFinite(params.price) && params.price > 0) {
    payload.price = String(params.price);
    payload.timeInForce = 'GTC';
  }

  const rawBody = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const recvWindow = '5000';
  const signature = signBybitV5Post({
    timestamp,
    apiKey: params.apiKey,
    secretKey: params.secretKey,
    recvWindow,
    rawBody,
  });

  const url = `${baseUrl}/v5/order/create`;
  const doFetch = params.fetchImpl || fetch;
  const referer = resolveBybitBrokerReferer(params.brokerReferer);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-BAPI-API-KEY': params.apiKey,
          'X-BAPI-TIMESTAMP': timestamp,
          'X-BAPI-RECV-WINDOW': recvWindow,
          'X-BAPI-SIGN': signature,
          ...(referer ? { 'X-BAPI-REFERER': referer } : {}),
        },
        body: rawBody,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const latencyMs = Math.max(1, Date.now() - start);
    const data: any = await res.json().catch(() => ({}));

    if (!res.ok) {
      return {
        submitted: false,
        environment: params.environment,
        latencyMs,
        error: `BYBIT_HTTP_${res.status}`,
      };
    }

    if (typeof data?.retCode === 'number' && data.retCode !== 0) {
      return {
        submitted: false,
        environment: params.environment,
        latencyMs,
        error: `Bybit (${data.retCode}): ${String(data.retMsg || 'ORDER_REJECTED')}`,
      };
    }

    return {
      submitted: true,
      environment: params.environment,
      orderId: data?.result?.orderId ? String(data.result.orderId) : undefined,
      orderLinkId: data?.result?.orderLinkId ? String(data.result.orderLinkId) : payload.orderLinkId,
      latencyMs,
    };
  } catch (err: any) {
    return {
      submitted: false,
      environment: params.environment,
      latencyMs: Math.max(1, Date.now() - start),
      error: err?.name === 'AbortError' ? 'BYBIT_TIMEOUT' : 'BYBIT_NETWORK_ERROR',
    };
  }
}

/**
 * Stateless Read-Only Live Ping & Permission Verifier (`GET /v5/user/query-api`).
 */
export async function verifyBybitCredentialLive(params: {
  apiKey: string;
  secretKey: string;
  environment: 'TESTNET' | 'MAINNET';
  fetchImpl?: typeof fetch;
}): Promise<BybitLivePingResult> {
  const start = Date.now();
  const baseUrl =
    params.environment === 'MAINNET' ? 'https://api.bybit.com' : 'https://api-testnet.bybit.com';
  const timestamp = String(Date.now());
  const recvWindow = '5000';
  const signature = signBybitV5Get({
    timestamp,
    apiKey: params.apiKey,
    secretKey: params.secretKey,
    recvWindow,
    queryString: '',
  });

  const url = `${baseUrl}/v5/user/query-api`;
  const doFetch = params.fetchImpl || fetch;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'GET',
        headers: {
          'X-BAPI-API-KEY': params.apiKey,
          'X-BAPI-TIMESTAMP': timestamp,
          'X-BAPI-RECV-WINDOW': recvWindow,
          'X-BAPI-SIGN': signature,
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const latencyMs = Math.max(1, Date.now() - start);
    const data: any = await res.json().catch(() => ({}));

    if (!res.ok) {
      return {
        connected: false,
        environment: params.environment,
        canTrade: false,
        canWithdraw: false,
        latencyMs,
        error: `BYBIT_HTTP_${res.status}`,
      };
    }

    if (typeof data?.retCode === 'number' && data.retCode !== 0) {
      return {
        connected: false,
        environment: params.environment,
        canTrade: false,
        canWithdraw: false,
        latencyMs,
        error: `Bybit (${data.retCode}): ${String(data.retMsg || 'API_REJECTED')}`,
      };
    }

    const perms = data?.result?.permissions || {};
    const spotPerms: string[] = Array.isArray(perms.Spot) ? perms.Spot : [];
    const contractPerms: string[] = Array.isArray(perms.ContractTrade) ? perms.ContractTrade : [];
    const walletPerms: string[] = Array.isArray(perms.Wallet) ? perms.Wallet : [];
    const readOnly = Number(data?.result?.readOnly) === 1;

    const canTrade = !readOnly && (spotPerms.length > 0 || contractPerms.length > 0);
    const canWithdraw = walletPerms.some((p) => /withdraw/i.test(String(p)));

    return {
      connected: true,
      environment: params.environment,
      canTrade,
      canWithdraw,
      readOnly,
      latencyMs,
      ...(canWithdraw ? { securityWarning: 'WITHDRAWAL_ENABLED_ON_EXCHANGE' as const } : {}),
    };
  } catch (err: any) {
    return {
      connected: false,
      environment: params.environment,
      canTrade: false,
      canWithdraw: false,
      latencyMs: Math.max(1, Date.now() - start),
      error: err?.name === 'AbortError' ? 'BYBIT_TIMEOUT' : 'BYBIT_NETWORK_ERROR',
    };
  }
}

export const bybitCexAdapter: CexExecutionAdapterContract = {
  providerId: 'BYBIT',
  verifyLivePermissions: async (creds) => {
    const res = await verifyBybitCredentialLive(creds);
    return {
      connected: res.connected,
      canTrade: res.canTrade,
      canWithdraw: res.canWithdraw,
      latencyMs: res.latencyMs,
      error: res.error,
    };
  },
};
