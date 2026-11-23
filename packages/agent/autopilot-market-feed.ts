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
