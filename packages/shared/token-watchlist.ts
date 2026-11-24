/**
 * packages/shared/token-watchlist.ts
 *
 * Pure, deterministic Pin / Favorite Token Watchlist engine (Phase CZ).
 * Persisted client-side in localStorage under WATCHLIST_STORAGE_KEY with strict cap & sanitization.
 */

export const WATCHLIST_STORAGE_KEY = 'poolnet_token_watchlist_v1';
export const MAX_WATCHLIST_ITEMS = 12;

export interface WatchlistTokenItem {
  id: string;
  symbol: string;
  name: string;
  chainId: number;
  address?: string;
  pinnedAt: string;
}

export type WatchlistTokenInput = Omit<WatchlistTokenItem, 'id' | 'pinnedAt'>;

export function normalizeWatchlistId(chainId: number, symbolOrAddress: string): string {
  const safeChain = Number.isFinite(chainId) && chainId > 0 ? Math.floor(chainId) : 8453;
  const cleanKey = (symbolOrAddress || '').trim().toLowerCase();
  return `${safeChain}:${cleanKey}`;
}

export function isWatchlistPinned(
  list: readonly WatchlistTokenItem[],
  chainId: number,
  symbolOrAddress: string
): boolean {
  const targetId = normalizeWatchlistId(chainId, symbolOrAddress);
  return list.some((item) => item.id === targetId);
}

export function toggleWatchlistItem(
  list: readonly WatchlistTokenItem[],
  input: WatchlistTokenInput,
  nowIso: string = new Date().toISOString()
): WatchlistTokenItem[] {
  const key = (input.address && input.address.trim()) || input.symbol;
  const id = normalizeWatchlistId(input.chainId, key);
  const exists = list.some((item) => item.id === id);
  if (exists) {
    return list.filter((item) => item.id !== id);
  }
  const cleanSymbol = (input.symbol || 'TOKEN').trim().toUpperCase().slice(0, 20);
  const cleanName = (input.name || cleanSymbol).trim().slice(0, 48);
  const cleanAddress = input.address?.trim() || undefined;
  const next: WatchlistTokenItem = {
    id,
    symbol: cleanSymbol,
    name: cleanName,
    chainId: Number.isFinite(input.chainId) && input.chainId > 0 ? Math.floor(input.chainId) : 8453,
    address: cleanAddress,
    pinnedAt: nowIso,
  };
  return [next, ...list].slice(0, MAX_WATCHLIST_ITEMS);
}

export function parseWatchlistStorage(raw: string | null): WatchlistTokenItem[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: WatchlistTokenItem[] = [];
    for (const row of parsed) {
      if (!row || typeof row !== 'object') continue;
      const symbol = typeof row.symbol === 'string' ? row.symbol.trim().toUpperCase() : '';
      const chainId = Number(row.chainId);
      if (!symbol || !Number.isFinite(chainId) || chainId <= 0) continue;
      const address = typeof row.address === 'string' && row.address.trim() ? row.address.trim() : undefined;
      const id = normalizeWatchlistId(chainId, address || symbol);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        symbol: symbol.slice(0, 20),
        name: typeof row.name === 'string' && row.name.trim() ? row.name.trim().slice(0, 48) : symbol,
        chainId: Math.floor(chainId),
        address,
        pinnedAt: typeof row.pinnedAt === 'string' ? row.pinnedAt : new Date().toISOString(),
      });
      if (out.length >= MAX_WATCHLIST_ITEMS) break;
    }
    return out;
  } catch {
    return [];
  }
}

export function buildWatchlistTradeHref(item: WatchlistTokenItem): string {
  if (item.address) {
    return `/trading?token=${encodeURIComponent(item.address)}&chainId=${item.chainId}`;
  }
  return `/trading?symbol=${encodeURIComponent(item.symbol)}`;
}
