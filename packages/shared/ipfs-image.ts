/**
 * packages/shared/ipfs-image.ts
 *
 * Pure, stateless IPFS & Token Image URL resolver with multi-gateway failover.
 * - Rewrites `ipfs://<CID>` and `/ipfs/<CID>` to ordered public HTTPS gateways.
 * - Filters out known dead/non-image URLs (e.g. broken default paths or bare HTML domains)
 *   so UI components immediately fall back to a crisp deterministic monogram avatar.
 */

export const PUBLIC_IPFS_GATEWAYS = [
  'https://gateway.pinata.cloud/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://dweb.link/ipfs/',
  'https://w3s.link/ipfs/',
] as const;

const KNOWN_IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif|svg|avif|ico)(\?.*)?$/i;

/**
 * Extracts an IPFS CID (and optional subpath) from `ipfs://...` or `https://.../ipfs/...`.
 */
export function extractIpfsCidPath(rawUrl?: string | null): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('ipfs://')) {
    const cleaned = trimmed.replace(/^ipfs:\/\/(ipfs\/)?/i, '').replace(/^\/+/, '');
    return cleaned.length >= 10 ? cleaned : null;
  }

  const match = trimmed.match(/\/ipfs\/([a-zA-Z0-9]+(?:\/[^?#]*)?)/i);
  if (match && match[1] && match[1].length >= 10) {
    return match[1];
  }

  return null;
}

/**
 * Detects URLs that are definitely NOT renderable image files
 * (e.g. missing local `/token-default.png`, dead domain, or bare HTML root pages like `https://foo.pages.dev`).
 */
export function isLikelyNonImageUrl(rawUrl?: string | null): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return true;
  const trimmed = rawUrl.trim();
  if (!trimmed) return true;

  // Data URI images are always valid
  if (trimmed.startsWith('data:image/')) return false;

  // IPFS URIs are valid (will be rewritten to gateways)
  if (extractIpfsCidPath(trimmed)) return false;

  // Known broken legacy fallback paths
  const lower = trimmed.toLowerCase();
  if (lower === '/token-default.png' || lower.includes('rtrader.io/token-default.png')) {
    return true;
  }

  // Relative local assets with valid image extension (e.g. /token-default.svg)
  if (trimmed.startsWith('/')) {
    return !KNOWN_IMAGE_EXTENSIONS.test(trimmed);
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return true;

    // Bare root URLs (pathname === '/' or '') like https://clankai-web3.pages.dev are HTML sites, not images
    if (!parsed.pathname || parsed.pathname === '/') {
      return true;
    }

    return false;
  } catch {
    return true;
  }
}

/**
 * Returns an ordered, deduplicated list of image URL candidates to attempt loading.
 * Empty array means the caller should render the deterministic monogram avatar immediately.
 */
export function resolveIpfsImageCandidates(rawUrl?: string | null): string[] {
  if (!rawUrl || typeof rawUrl !== 'string') return [];
  const trimmed = rawUrl.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('data:image/')) {
    return [trimmed];
  }

  const cidPath = extractIpfsCidPath(trimmed);
  if (cidPath) {
    const candidates: string[] = [];
    // If caller already passed a specific gateway URL, keep it first unless it's raw ipfs://
    if (trimmed.startsWith('https://')) {
      candidates.push(trimmed);
    }
    for (const gw of PUBLIC_IPFS_GATEWAYS) {
      const url = `${gw}${cidPath}`;
      if (!candidates.includes(url)) {
        candidates.push(url);
      }
    }
    return candidates;
  }

  if (isLikelyNonImageUrl(trimmed)) {
    return [];
  }

  return [trimmed];
}

/**
 * Computes a deterministic gradient pair (start, end) from a seed string (contract address or ticker).
 */
export function getDeterministicAvatarGradient(seed: string): [string, string] {
  const palettes: Array<[string, string]> = [
    ['#4285F4', '#9B72CB'],
    ['#0EA5E9', '#10B981'],
    ['#6366F1', '#EC4899'],
    ['#F59E0B', '#EF4444'],
    ['#14B8A6', '#3B82F6'],
    ['#8B5CF6', '#06B6D4'],
    ['#22C55E', '#14B8A6'],
    ['#EAB308', '#F97316'],
  ];
  let hash = 0;
  const input = (seed || 'POOLNET').toLowerCase();
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return palettes[hash % palettes.length];
}
