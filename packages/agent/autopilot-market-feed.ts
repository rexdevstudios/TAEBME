/**
 * packages/agent/autopilot-market-feed.ts
 *
 * Multi-Tenant Auto-Pilot Active Wallet Registry & Live Spot Price Feed Adapter (Phase BN).
 * - Zero-DDL: stores active wallet index under `agent:autopilot:active_wallets` in Upstash Redis
 *   (with in-memory mirror for offline/unit-test environments).
 * - Fetches public Binance Spot ticker prices (zero API key, timeout 3.5s, fault-isolated)
 *   for deterministic TP/SL evaluation inside the 24/7 execution-plane worker.
 */

import { upstashRedis } from '../shared/redis-client';
import type { AutoPilotOpenPosition } from './autopilot-cycle-runner';

export const AUTOPILOT_ACTIVE_WALLETS_KEY = 'agent:autopilot:active_wallets';
const MAX_ACTIVE_AUTOPILOT_WALLETS = 500;

let inMemoryActiveWallets: string[] = [];

export function updateActiveAutoPilotWalletList(
  existing: string[],
  wallet: string,
  enabled: boolean
): string[] {
  const norm = String(wallet || '').trim().toLowerCase();
  if (!norm) return Array.isArray(existing) ? [...existing] : [];

  const deduped = Array.from(
    new Set(
      (Array.isArray(existing) ? existing : [])
        .map((w) => String(w || '').trim().toLowerCase())
        .filter(Boolean)
    )
  ).filter((w) => w !== norm);

  if (enabled) {
    deduped.unshift(norm);
  }

  return deduped.slice(0, MAX_ACTIVE_AUTOPILOT_WALLETS);
}

export async function listActiveAutoPilotWallets(): Promise<string[]> {
  if (upstashRedis.isConfigured()) {
    const raw = await upstashRedis.get<string>(AUTOPILOT_ACTIVE_WALLETS_KEY).catch(() => null);
    if (raw) {
      try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(parsed)) {
          inMemoryActiveWallets = parsed.map((w) => String(w || '').trim().toLowerCase()).filter(Boolean);
          return [...inMemoryActiveWallets];
        }
      } catch {
        // fallback to in-memory mirror
      }
    }
  }
  return [...inMemoryActiveWallets];
}

export async function syncActiveAutoPilotRegistry(
  wallet: string,
  enabled: boolean
): Promise<string[]> {
  const current = await listActiveAutoPilotWallets();
  const next = updateActiveAutoPilotWalletList(current, wallet, enabled);
  inMemoryActiveWallets = next;
  if (upstashRedis.isConfigured()) {
    await upstashRedis
      .set(AUTOPILOT_ACTIVE_WALLETS_KEY, JSON.stringify(next), 30 * 86400)
      .catch(() => false);
  }
  return next;
}

export async function fetchAutoPilotSpotPrices(
  symbols: string[],
  fetchImpl: typeof fetch = fetch
): Promise<Record<string, number>> {
  const uniqueSymbols = Array.from(
    new Set(
      (Array.isArray(symbols) ? symbols : [])
        .map((s) => String(s || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, ''))
        .filter((s) => s.length >= 3 && s.length <= 20)
    )
  ).slice(0, 20);

  const prices: Record<string, number> = {};
  await Promise.all(
    uniqueSymbols.map(async (sym) => {
      try {
        const res = await fetchImpl(
          `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(sym)}`,
          { signal: AbortSignal.timeout(3500) }
        );
        if (!res.ok) return;
        const json = (await res.json()) as { price?: string };
        const parsed = Number(json?.price);
        if (Number.isFinite(parsed) && parsed > 0) {
          prices[sym] = parsed;
        }
      } catch {
        // Non-fatal per-symbol price fetch fallback
      }
    })
  );

  return prices;
}

export function hydrateOpenPositionsWithLivePrices(
  positions: AutoPilotOpenPosition[],
  livePrices: Record<string, number>
): AutoPilotOpenPosition[] {
  return (Array.isArray(positions) ? positions : []).map((pos) => {
    const cleanSym = String(pos.symbol || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const live = livePrices[cleanSym];
    return {
      ...pos,
      currentPrice: Number.isFinite(live) && live > 0 ? live : pos.currentPrice,
    };
  });
}

export interface AutoPilot24hTicker {
  symbol: string;
  lastPrice: number;
  priceChangePct24h: number;
  quoteVolumeUsd: number;
}

/**
 * Pure deterministic 24h momentum & liquidity confidence scorer (Phase BV1).
 * Avoids overextended FOMO pumps (>25%) and falling knives (<-10%), rewarding healthy momentum + deep liquidity.
 */
export function computeDynamicSignalConfidence(params: {
  priceChangePct24h: number;
  quoteVolumeUsd: number;
}): number {
  let score = 62;
  const pct = Number(params.priceChangePct24h);
  const vol = Number(params.quoteVolumeUsd);

  if (Number.isFinite(pct)) {
    if (pct >= 1.5 && pct <= 12) score += 14;
    else if (pct > 12 && pct <= 22) score += 6;
    else if (pct > 25 || pct < -10) score -= 12;
  }

  if (Number.isFinite(vol)) {
    if (vol >= 50_000_000) score += 10;
    else if (vol >= 10_000_000) score += 6;
    else if (vol > 0 && vol < 500_000) score -= 8;
  }

  return Math.max(45, Math.min(95, Math.round(score)));
}

/**
 * Fetches public 24h tickers from Binance Spot (zero API key, fault-isolated, 3.5s timeout).
 */
export async function fetchAutoPilot24hTickers(
  symbols: string[],
  fetchImpl: typeof fetch = fetch
): Promise<Record<string, AutoPilot24hTicker>> {
  const uniqueSymbols = Array.from(
    new Set(
      (Array.isArray(symbols) ? symbols : [])
        .map((s) => String(s || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, ''))
        .filter((s) => s.length >= 3 && s.length <= 20)
    )
  ).slice(0, 20);

  const tickers: Record<string, AutoPilot24hTicker> = {};
  await Promise.all(
    uniqueSymbols.map(async (sym) => {
      try {
        const res = await fetchImpl(
          `https://api.binance.com/api/v3/ticker/24hr?symbol=${encodeURIComponent(sym)}`,
          { signal: AbortSignal.timeout(3500) }
        );
        if (!res.ok) return;
        const json = (await res.json()) as {
          lastPrice?: string;
          priceChangePercent?: string;
          quoteVolume?: string;
        };
        const lastPrice = Number(json?.lastPrice);
        if (Number.isFinite(lastPrice) && lastPrice > 0) {
          tickers[sym] = {
            symbol: sym,
            lastPrice,
            priceChangePct24h: Number(json?.priceChangePercent || 0),
            quoteVolumeUsd: Number(json?.quoteVolume || 0),
          };
        }
      } catch {
        // Non-fatal per-symbol ticker fallback
      }
    })
  );

  return tickers;
}

/**
 * Derives currently open positions from persisted `trade_intents` without requiring any DB DDL (Phase BV1).
 * A symbol is considered open if its latest EXECUTED intent is a BUY with a valid positive price
 * and no newer EXECUTED SELL exists for the same symbol.
 */
export function deriveOpenPositionsFromTradeIntents(
  intents: Array<{
    symbol: string;
    side: string;
    quantity: number;
    price?: number;
    status: string;
    createdAt?: string;
  }>
): AutoPilotOpenPosition[] {
  const sorted = [...(Array.isArray(intents) ? intents : [])].sort(
    (a, b) => Date.parse(b.createdAt || '0') - Date.parse(a.createdAt || '0')
  );

  const seenSymbols = new Set<string>();
  const openPositions: AutoPilotOpenPosition[] = [];

  for (const item of sorted) {
    if (String(item.status || '').toUpperCase() !== 'EXECUTED') continue;
    const sym = String(item.symbol || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!sym || seenSymbols.has(sym)) continue;
    seenSymbols.add(sym);

    if (String(item.side || '').toUpperCase() === 'BUY') {
      const entryPrice = Number(item.price || 0);
      const quantity = Number(item.quantity || 0);
      if (Number.isFinite(entryPrice) && entryPrice > 0 && Number.isFinite(quantity) && quantity > 0) {
        openPositions.push({
          symbol: sym,
          entryPrice,
          currentPrice: entryPrice,
          quantity,
        });
      }
    }
  }

  return openPositions;
}
