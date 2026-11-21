/**
 * packages/shared/launchpad-discovery.ts
 *
 * Pure, stateless discovery filtering & sorting for Launchpad token cards.
 * Supports:
 *  - Search by token name, ticker, or contract address
 *  - Chain filter ('all', 'base', 'robinhood', 'solana', 'arbitrum', 'arc', ...)
 *  - Sort tabs ('trending', 'newest', 'graduating', 'safest')
 */

export type LaunchpadSortMode = 'trending' | 'newest' | 'graduating' | 'safest';

export interface LaunchpadTokenItem {
  launchId?: string;
  contractAddress: string;
  chain?: string;
  name?: string;
  ticker?: string;
  imageUrl?: string | null;
  raisedAmount?: number | string;
  graduationThreshold?: number | string;
  isGraduated?: boolean;
  riskScore?: number | string;
  publishedAt?: string | Date;
  launchMode?: string;
}

export function normalizeDiscoveryChain(rawChain?: string): string {
  const c = (rawChain || 'base').toLowerCase();
  if (c.includes('solana') || c === 'sol') return 'solana';
  if (c.includes('robinhood') || c === 'rh') return 'robinhood';
  if (c.includes('arbitrum') || c === 'arb') return 'arbitrum';
  if (c.includes('arc')) return 'arc';
  if (c.includes('bsc') || c.includes('bnb')) return 'bsc';
  if (c.includes('ethereum') || c === 'eth') return 'ethereum';
  return 'base';
}

export function computeGraduationProgressPct(token: LaunchpadTokenItem): number {
  if (token.isGraduated) return 100;
  const raised = Number(token.raisedAmount || 0);
  const target = Math.max(1, Number(token.graduationThreshold || 69000));
  return Math.min(100, Math.max(0, Math.round((raised / target) * 100)));
}

export function filterAndSortLaunchTokens<T extends LaunchpadTokenItem>(
  tokens: T[],
  options: {
    search?: string;
    chain?: string;
    sort?: LaunchpadSortMode;
    onlyGraduated?: boolean;
  }
): T[] {
  const query = (options.search || '').trim().toLowerCase();
  const targetChain = (options.chain || 'all').toLowerCase();
  const sortMode: LaunchpadSortMode = options.sort || 'trending';

  const filtered = tokens.filter((t) => {
    if (options.onlyGraduated && !t.isGraduated) return false;

    if (targetChain !== 'all') {
      const norm = normalizeDiscoveryChain(t.chain);
      if (norm !== targetChain) return false;
    }

    if (query) {
      const name = (t.name || '').toLowerCase();
      const ticker = (t.ticker || '').toLowerCase();
      const addr = (t.contractAddress || '').toLowerCase();
      if (!name.includes(query) && !ticker.includes(query) && !addr.includes(query)) {
        return false;
      }
    }

    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    const progA = computeGraduationProgressPct(a);
    const progB = computeGraduationProgressPct(b);
    const raisedA = Number(a.raisedAmount || 0);
    const raisedB = Number(b.raisedAmount || 0);
    const riskA = Number(a.riskScore ?? 90);
    const riskB = Number(b.riskScore ?? 90);
    const timeA = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const timeB = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;

    if (sortMode === 'newest') {
      return timeB - timeA;
    }
    if (sortMode === 'graduating') {
      if (Boolean(b.isGraduated) !== Boolean(a.isGraduated)) {
        return Number(Boolean(b.isGraduated)) - Number(Boolean(a.isGraduated));
      }
      if (progB !== progA) return progB - progA;
      return raisedB - raisedA;
    }
    if (sortMode === 'safest') {
      if (riskB !== riskA) return riskB - riskA;
      return raisedB - raisedA;
    }

    // Default: 'trending' — combines raised progress + recency momentum
    if (progB !== progA) return progB - progA;
    if (raisedB !== raisedA) return raisedB - raisedA;
    return timeB - timeA;
  });

  return sorted;
}
