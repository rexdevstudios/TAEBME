/**
 * packages/trading/paper-wallet.ts
 *
 * Pure, deterministic Multi-Chain Navbar Catalog & Virtual Paper Trading Wallet Engine (Phase EK).
 * - Zero I/O, zero secrets, zero DDL migrations.
 * - Provides unified EVM chain metadata (including opBNB 204, BNB Chain 56, Ethereum 1, Polygon 137, Optimism 10, Base 8453, Arbitrum 42161, Robinhood L2, Arc Network).
 * - Manages Virtual Paper Trading Balance ($10,000 default) with strict insufficient-balance guard on BUY.
 */

export interface NavbarChainOption {
  hex: string;
  chainId: number;
  label: string;
  nativeSymbol: string;
}

export const KNOWN_NAVBAR_CHAINS: readonly NavbarChainOption[] = [
  { hex: '0x2105', chainId: 8453, label: 'Base Mainnet', nativeSymbol: 'ETH' },
  { hex: '0x14a34', chainId: 84532, label: 'Base Sepolia', nativeSymbol: 'ETH' },
  { hex: '0x1', chainId: 1, label: 'Ethereum', nativeSymbol: 'ETH' },
  { hex: '0xa4b1', chainId: 42161, label: 'Arbitrum One', nativeSymbol: 'ETH' },
  { hex: '0xa', chainId: 10, label: 'Optimism', nativeSymbol: 'ETH' },
  { hex: '0x89', chainId: 137, label: 'Polygon PoS', nativeSymbol: 'POL' },
  { hex: '0x38', chainId: 56, label: 'BNB Chain', nativeSymbol: 'BNB' },
  { hex: '0xcc', chainId: 204, label: 'opBNB', nativeSymbol: 'BNB' },
  { hex: '0x1237', chainId: 4663, label: 'Robinhood L2', nativeSymbol: 'ETH' },
  { hex: '0x13b2', chainId: 5042, label: 'Arc Network', nativeSymbol: 'USDC' },
];

export function resolveChainDisplayMeta(chainIdHex: string | null | undefined): {
  known: boolean;
  hex: string;
  chainId: number;
  label: string;
  nativeSymbol: string;
} {
  const norm = String(chainIdHex || '').trim().toLowerCase();
  const match = KNOWN_NAVBAR_CHAINS.find((c) => c.hex === norm);
  if (match) {
    return { known: true, ...match };
  }
  const numeric = norm ? parseInt(norm, 16) : NaN;
  return {
    known: false,
    hex: norm || '0x2105',
    chainId: Number.isFinite(numeric) ? numeric : 0,
    label: Number.isFinite(numeric) ? `Chain ${numeric}` : 'Unknown Chain',
    nativeSymbol: 'ETH',
  };
}

export const DEFAULT_PAPER_BALANCE_USD = 10_000;
export const PAPER_WALLET_STORAGE_PREFIX = 'poolnet:paper_balance:v1:';

export interface PaperBalanceUpdateResult {
  ok: boolean;
  nextBalanceUsd: number;
  notionalUsd: number;
  reason?: string;
}

/**
 * Applies a simulated PAPER BUY/SELL order against the user's virtual USD balance.
 * Rejects BUY if notionalUsd exceeds available virtual balance.
 */
export function applyPaperTradeBalance(params: {
  currentBalanceUsd: number;
  side: 'BUY' | 'SELL';
  notionalUsd: number;
}): PaperBalanceUpdateResult {
  const current = Number.isFinite(params.currentBalanceUsd)
    ? Math.max(0, Math.round(params.currentBalanceUsd * 100) / 100)
    : DEFAULT_PAPER_BALANCE_USD;
  const notional = Number.isFinite(params.notionalUsd)
    ? Math.max(0, Math.round(params.notionalUsd * 100) / 100)
    : 0;

  if (notional <= 0) {
    return {
      ok: false,
      nextBalanceUsd: current,
      notionalUsd: 0,
      reason: 'INVALID_NOTIONAL: Nominal simulasi harus lebih besar dari $0.',
    };
  }

  if (params.side === 'BUY') {
    if (notional > current) {
      return {
        ok: false,
        nextBalanceUsd: current,
        notionalUsd: notional,
        reason: `INSUFFICIENT_PAPER_BALANCE: Saldo virtual $${current.toLocaleString()} tidak cukup untuk BUY $${notional.toLocaleString()}. Klik "Reset $10K" atau perkecil jumlah.`,
      };
    }
    return {
      ok: true,
      nextBalanceUsd: Math.round((current - notional) * 100) / 100,
      notionalUsd: notional,
    };
  }

  // SELL credits virtual USD balance back
  return {
    ok: true,
    nextBalanceUsd: Math.round((current + notional) * 100) / 100,
    notionalUsd: notional,
  };
}

/**
 * Formats an EVM hex wei balance (`eth_getBalance` response) into a clean human string (e.g. "0.0425 ETH").
 */
export function formatNativeWeiBalance(hexWei: string | null | undefined, symbol: string = 'ETH'): string {
  if (!hexWei || typeof hexWei !== 'string') return `0.0000 ${symbol}`;
  try {
    const wei = BigInt(hexWei);
    const whole = wei / 1_000_000_000_000_000_000n;
    const rem = wei % 1_000_000_000_000_000_000n;
    const dec4 = (rem / 100_000_000_000_000n).toString().padStart(4, '0');
    return `${whole.toString()}.${dec4} ${symbol}`;
  } catch {
    return `0.0000 ${symbol}`;
  }
}

/**
 * Resolves the canonical Base hex chainId for the active environment hostname (Testnet vs Production).
 */
export function resolveDefaultBaseChainHex(hostname?: string): '0x14a34' | '0x2105' {
  const host =
    hostname !== undefined
      ? hostname
      : typeof window !== 'undefined'
        ? window.location.hostname
        : '';
  return host === 'testnet.pndigi.site' ? '0x14a34' : '0x2105';
}

/**
 * Maps Launchpad deployer chain keys (`base` | `robinhood` | `arbitrum` | `arc`) to their hex chainId.
 */
export function resolveLaunchpadChainHex(
  chain: 'base' | 'robinhood' | 'arbitrum' | 'arc' | string,
  hostname?: string
): string {
  const clean = String(chain || 'base').trim().toLowerCase();
  if (clean === 'robinhood') return '0x1237';
  if (clean === 'arbitrum') return '0xa4b1';
  if (clean === 'arc') return '0x13b2';
  return resolveDefaultBaseChainHex(hostname);
}
