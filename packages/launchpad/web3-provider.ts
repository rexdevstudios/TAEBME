// ============================================================================
// REUSABLE WEB3 CLIENT PROVIDER & BASE CHAIN ENFORCEMENT
// Aligned with SSOT, AGENTS.md, Rule 6, 7, 8, 9 of Forensic Architecture
// ============================================================================

import { ethers } from 'ethers';
import { BONDING_CURVE_LAUNCHPAD_ABI } from './contracts/BondingCurveLaunchpadAbi';
import { getEnvironmentConfig, validateChainAndContractConsistency } from '../shared/env-config';

export interface ChainConfig {
  chainId: number;
  hexChainId: string;
  name: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrl: string;
  explorerUrl: string;
}

export const SUPPORTED_BASE_CHAINS: Record<string, ChainConfig> = {
  BASE_MAINNET: {
    chainId: 8453,
    hexChainId: '0x2105',
    name: 'Base Mainnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrl: 'https://mainnet.base.org',
    explorerUrl: 'https://basescan.org',
  },
  BASE_SEPOLIA: {
    chainId: 84532,
    hexChainId: '0x14a34',
    name: 'Base Sepolia Testnet',
    nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
    rpcUrl: 'https://sepolia.base.org',
    explorerUrl: 'https://sepolia.basescan.org',
  },
  ROBINHOOD_MAINNET: {
    chainId: 4663,
    hexChainId: '0x1237',
    name: 'Robinhood Chain L2',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
    explorerUrl: 'https://robinhoodchain.blockscout.com',
  },
  ARBITRUM_MAINNET: {
    chainId: 42161,
    hexChainId: '0xa4b1',
    name: 'Arbitrum One',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
    explorerUrl: 'https://arbiscan.io',
  },
  ARC_MAINNET: {
    chainId: 5042,
    hexChainId: '0x13b2',
    name: 'Arc Network',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrl: 'https://rpc.arcnetwork.io',
    explorerUrl: 'https://arcscan.io',
  },
};

// Known dummy / simulation addresses that MUST NEVER be permitted for live write transactions
const REJECTED_DUMMY_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x1111111111111111111111111111111111111111',
  '0x2222222222222222222222222222222222222222',
]);

export interface ContractConfigStatus {
  isConfigured: boolean;
  status: 'CONFIGURED' | 'BLOCKED_UNVERIFIED' | 'BLOCKED_DUMMY_ADDRESS' | 'BLOCKED_INVALID_ADDRESS';
  contractAddress: string | null;
  message: string;
}

/**
 * Validates configured contract address against Rule 6 hard security constraints.
 * Rejects missing, zero, malformed, or dummy addresses.
 */
export function getContractConfiguration(overrideAddress?: string | null): ContractConfigStatus {
  const winOverride =
    typeof window !== 'undefined' && typeof (window as any).__RTRADER_LAUNCHPAD_CONTRACT__ === 'string'
      ? (window as any).__RTRADER_LAUNCHPAD_CONTRACT__.trim()
      : '';
  const envAddress = (overrideAddress?.trim() || winOverride || process.env.NEXT_PUBLIC_LAUNCHPAD_CONTRACT_ADDRESS?.trim()) || '';

  if (!envAddress) {
    return {
      isConfigured: false,
      status: 'BLOCKED_UNVERIFIED',
      contractAddress: null,
      message: 'BLOCKED — Smart contract belum ter-deploy atau NEXT_PUBLIC_LAUNCHPAD_CONTRACT_ADDRESS belum diset. Anda dapat menyetel alamat kontrak di halaman Billing & Tiers (Admin Configurator) atau gunakan tombol Bankr Deploy di atas.',
    };
  }

  if (REJECTED_DUMMY_ADDRESSES.has(envAddress.toLowerCase())) {
    return {
      isConfigured: false,
      status: 'BLOCKED_DUMMY_ADDRESS',
      contractAddress: null,
      message: 'BLOCKED — Alamat kontrak adalah dummy/mock address (0x111...111). Transaksi on-chain diblokir.',
    };
  }

  if (!ethers.isAddress(envAddress)) {
    return {
      isConfigured: false,
      status: 'BLOCKED_INVALID_ADDRESS',
      contractAddress: null,
      message: 'BLOCKED — Alamat kontrak bukan alamat Ethereum (EVM) yang valid.',
    };
  }

  return {
    isConfigured: true,
    status: 'CONFIGURED',
    contractAddress: ethers.getAddress(envAddress),
    message: 'Alamat smart contract terverifikasi.',
  };
}

/**
 * Resolves the best available EIP-1193 provider in multi-wallet browsers
 * (prioritizes MetaMask when window.ethereum.providers has multiple extensions like TokenPocket + MetaMask).
 */
export function resolveBrowserEthereumProvider(): any | null {
  if (typeof window === 'undefined') return null;
  const eth = (window as any).ethereum;
  if (!eth) return null;
  if (Array.isArray(eth.providers) && eth.providers.length > 0) {
    const mm = eth.providers.find((p: any) => p?.isMetaMask && !p?.isBraveWallet && !p?.isTokenPocket);
    if (mm) return mm;
    const anyMm = eth.providers.find((p: any) => p?.isMetaMask);
    return anyMm || eth.providers[0];
  }
  return eth;
}

/**
 * Returns an ethers BrowserProvider instance connected to the resolved EIP-1193 provider.
 */
export function getBrowserProvider(): ethers.BrowserProvider {
  const ethereum = resolveBrowserEthereumProvider();
  if (!ethereum) {
    throw new Error('WALLET_NOT_DETECTED: Ekstensi MetaMask atau dompet Web3 EIP-1193 tidak ditemukan.');
  }
  return new ethers.BrowserProvider(ethereum);
}

/**
 * Returns a signer from the browser wallet.
 */
export async function getBrowserSigner(): Promise<ethers.JsonRpcSigner> {
  const provider = getBrowserProvider();
  return provider.getSigner();
}

/**
 * Reads current chainId from the connected browser wallet.
 */
export async function getCurrentChainId(): Promise<number> {
  const provider = getBrowserProvider();
  const network = await provider.getNetwork();
  return Number(network.chainId);
}

function isUnrecognizedChainError(err: any): boolean {
  const codes = [err?.code, err?.data?.originalError?.code, err?.error?.code];
  if (codes.some((c) => c === 4902 || String(c) === '4902')) return true;
  const msg = [err?.message, err?.data?.originalError?.message, err?.error?.message]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return msg.includes('unrecognized chain') || msg.includes('try adding the chain') || msg.includes('wallet_addethereumchain');
}

/**
 * Validates and enforces that the browser wallet is connected to the target EVM network.
 * Sends EIP-3326 wallet_switchEthereumChain directly to MetaMask/EIP-1193 provider,
 * falling back to EIP-3085 wallet_addEthereumChain on error 4902, then verifies eth_chainId.
 */
export async function ensureBaseNetwork(
  targetHexChainId?: string
): Promise<{ success: boolean; chainId?: number; hexChainId?: string; error?: string }> {
  const ethereum = resolveBrowserEthereumProvider();
  if (!ethereum) {
    return { success: false, error: 'Dompet Web3 (MetaMask) tidak terdeteksi di browser ini.' };
  }

  // Resolve default target chain safely in browser runtime without requiring server-only process.env.APP_ENV
  let fallbackHex = '0x2105';
  let isTestnetHost = false;
  if (typeof window !== 'undefined' && window.location?.hostname === 'testnet.pndigi.site') {
    fallbackHex = '0x14a34';
    isTestnetHost = true;
  } else {
    try {
      const envConfig = getEnvironmentConfig();
      fallbackHex = envConfig.chainHex;
      isTestnetHost = envConfig.env === 'testnet';
    } catch {
      fallbackHex = '0x2105';
    }
  }

  const hexChain = (targetHexChainId || fallbackHex).toLowerCase();

  const targetConfig =
    Object.values(SUPPORTED_BASE_CHAINS).find(
      (c) => c.hexChainId.toLowerCase() === hexChain
    ) || (isTestnetHost ? SUPPORTED_BASE_CHAINS.BASE_SEPOLIA : SUPPORTED_BASE_CHAINS.BASE_MAINNET);

  // Validate chain consistency with known network registry
  try {
    validateChainAndContractConsistency(targetConfig.chainId);
  } catch (err: any) {
    return { success: false, error: err.message };
  }

  try {
    const currentChainHex: string = await ethereum.request({ method: 'eth_chainId' });
    if (currentChainHex && currentChainHex.toLowerCase() === targetConfig.hexChainId.toLowerCase()) {
      return { success: true, chainId: targetConfig.chainId, hexChainId: currentChainHex.toLowerCase() };
    }

    // Attempt direct EIP-3326 switch in MetaMask
    try {
      await ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: targetConfig.hexChainId }],
      });
    } catch (switchErr: any) {
      // Error code 4902 (direct or nested): Unrecognized chain, add via EIP-3085
      if (isUnrecognizedChainError(switchErr)) {
        await ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [
            {
              chainId: targetConfig.hexChainId,
              chainName: targetConfig.name,
              nativeCurrency: targetConfig.nativeCurrency,
              rpcUrls: [targetConfig.rpcUrl],
              blockExplorerUrls: [targetConfig.explorerUrl],
            },
          ],
        });
      } else if (switchErr?.code === 4001) {
        return {
          success: false,
          error: 'USER_REJECTED: Pengguna menolak perpindahan jaringan ke ' + targetConfig.name,
        };
      } else if (switchErr?.code === -32002) {
        return {
          success: false,
          error: 'Permintaan pindah jaringan sudah terbuka di MetaMask. Klik ikon ekstensi MetaMask (🦊) di toolbar browser.',
        };
      } else {
        throw switchErr;
      }
    }

    // Verify actual active chainId reported by MetaMask post-switch
    const verifiedHex: string = await ethereum
      .request({ method: 'eth_chainId' })
      .catch(() => targetConfig.hexChainId);
    const normVerified = (verifiedHex || targetConfig.hexChainId).toLowerCase();
    return {
      success: true,
      chainId: parseInt(normVerified, 16) || targetConfig.chainId,
      hexChainId: normVerified,
    };
  } catch (err: any) {
    if (err?.code === 4001) {
      return {
        success: false,
        error: 'USER_REJECTED: Pengguna menolak penambahan/perpindahan jaringan ke ' + targetConfig.name,
      };
    }
    return { success: false, error: err?.message || 'Gagal mengubah jaringan dompet.' };
  }
}

/**
 * Authoritative 6-Chain EVM DEX Registry (100% parity with 0x Swap API v2 `ZEROX_SUPPORTED_CHAIN_IDS`).
 */
export const EVM_DEX_CHAINS: Record<number, ChainConfig> = {
  8453: SUPPORTED_BASE_CHAINS.BASE_MAINNET,
  42161: SUPPORTED_BASE_CHAINS.ARBITRUM_MAINNET,
  1: {
    chainId: 1,
    hexChainId: '0x1',
    name: 'Ethereum Mainnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrl: 'https://eth.llamarpc.com',
    explorerUrl: 'https://etherscan.io',
  },
  10: {
    chainId: 10,
    hexChainId: '0xa',
    name: 'Optimism Mainnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrl: 'https://mainnet.optimism.io',
    explorerUrl: 'https://optimistic.etherscan.io',
  },
  137: {
    chainId: 137,
    hexChainId: '0x89',
    name: 'Polygon PoS',
    nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
    rpcUrl: 'https://polygon-rpc.com',
    explorerUrl: 'https://polygonscan.com',
  },
  56: {
    chainId: 56,
    hexChainId: '0x38',
    name: 'BNB Smart Chain',
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    rpcUrl: 'https://bsc-dataseed.binance.org',
    explorerUrl: 'https://bscscan.com',
  },
};

export function getEvmExplorerTxUrl(chainId: number, txHash: string): string {
  const cfg = EVM_DEX_CHAINS[chainId] || SUPPORTED_BASE_CHAINS.BASE_MAINNET;
  return `${cfg.explorerUrl.replace(/\/+$/, '')}/tx/${txHash}`;
}

export function encodeDexSettlementIdempotencyKey(params: {
  chainId: number;
  txHash: string;
  intentId: string;
}): string {
  const cid = Number(params.chainId);
  if (!Number.isInteger(cid) || !EVM_DEX_CHAINS[cid]) {
    throw new Error(`UNSUPPORTED_DEX_SETTLEMENT_CHAIN_${params.chainId}`);
  }
  const cleanHash = String(params.txHash || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{64}$/.test(cleanHash)) {
    throw new Error('INVALID_DEX_SETTLEMENT_TX_HASH');
  }
  const cleanId = String(params.intentId || '')
    .trim()
    .replace(/[^a-zA-Z0-9-]/g, '')
    .slice(0, 12) || 'intent';
  return `dex:${cid}:${cleanHash}:${cleanId}`;
}

export function parseDexSettlementFromIdempotencyKey(
  idempotencyKey: string | null | undefined
): { chainId: number; txHash: string; explorerUrl: string } | null {
  if (!idempotencyKey || typeof idempotencyKey !== 'string') return null;
  const match = idempotencyKey.trim().match(/^dex:(\d+):(0x[a-fA-F0-9]{64})(?::[a-zA-Z0-9-]+)?$/);
  if (!match) return null;
  const chainId = Number(match[1]);
  if (!EVM_DEX_CHAINS[chainId]) return null;
  const txHash = match[2].toLowerCase();
  return {
    chainId,
    txHash,
    explorerUrl: getEvmExplorerTxUrl(chainId, txHash),
  };
}

/**
 * Extracts structured on-chain DEX settlement metadata from `audit_logs.reason`
 * written by `confirmUserDexTradeIntentSettlement` (Phase BH2).
 */
export function parseDexSettlementFromAuditReason(
  reason: string | null | undefined
): { chainId: number; txHash: string; explorerUrl: string } | null {
  if (!reason || typeof reason !== 'string') return null;
  const match = reason.match(/chain\s+(\d+)\s*:\s*(0x[a-fA-F0-9]{64})/i);
  if (!match) return null;
  const chainId = Number(match[1]);
  if (!EVM_DEX_CHAINS[chainId]) return null;
  const txHash = match[2].toLowerCase();
  return {
    chainId,
    txHash,
    explorerUrl: getEvmExplorerTxUrl(chainId, txHash),
  };
}

export type TradeIntentHistoryFilter = 'ALL' | 'DEX_SETTLED' | 'CEX_OR_PAPER' | 'REJECTED';

export interface TradeIntentSummaryCounts {
  total: number;
  dexSettled: number;
  cexOrPaper: number;
  approved: number;
  rejected: number;
}

/**
 * Pure summary & filter helper for `RecentTradeHistoryPanel` (Phase BH1 + BJ1).
 */
export function summarizeAndFilterTradeIntents<
  T extends { status: string; idempotencyKey?: string }
>(
  intents: T[],
  filter: TradeIntentHistoryFilter = 'ALL',
  chainIdFilter: number | null = null
): { counts: TradeIntentSummaryCounts; filtered: T[] } {
  const list = Array.isArray(intents) ? intents : [];
  let dexSettled = 0;
  let cexOrPaper = 0;
  let approved = 0;
  let rejected = 0;

  for (const item of list) {
    const isDex = Boolean(parseDexSettlementFromIdempotencyKey(item.idempotencyKey));
    const st = String(item.status || '').toUpperCase();
    const isRej = st === 'REJECTED' || st === 'BLOCKED' || st === 'CANCELLED';
    const isApp = st === 'APPROVED' || st === 'EXECUTED';
    if (isDex) dexSettled += 1;
    if (!isDex && !isRej) cexOrPaper += 1;
    if (isApp) approved += 1;
    if (isRej) rejected += 1;
  }

  const normalizedChainId =
    chainIdFilter !== null && Number.isInteger(Number(chainIdFilter)) && Number(chainIdFilter) > 0
      ? Number(chainIdFilter)
      : null;

  const filtered = list.filter((item) => {
    const settlement = parseDexSettlementFromIdempotencyKey(item.idempotencyKey);
    const isDex = Boolean(settlement);
    const st = String(item.status || '').toUpperCase();
    const isRej = st === 'REJECTED' || st === 'BLOCKED' || st === 'CANCELLED';
    if (filter === 'DEX_SETTLED' && !isDex) return false;
    if (filter === 'CEX_OR_PAPER' && (isDex || isRej)) return false;
    if (filter === 'REJECTED' && !isRej) return false;
    if (normalizedChainId !== null) {
      if (!settlement || settlement.chainId !== normalizedChainId) return false;
    }
    return true;
  });

  return {
    counts: {
      total: list.length,
      dexSettled,
      cexOrPaper,
      approved,
      rejected,
    },
    filtered,
  };
}

function escapeCsvCell(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value);
  const formulaSafe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  if (/[",\r\n]/.test(formulaSafe)) {
    return `"${formulaSafe.replace(/"/g, '""')}"`;
  }
  return formulaSafe;
}

/**
 * Serializes trade intents into RFC-4180 CSV with spreadsheet formula-injection protection (Phase BJ1).
 */
export function serializeTradeIntentsToCsv(
  intents: Array<{
    id: string;
    createdAt?: string;
    stage: string;
    side: string;
    symbol: string;
    quantity: number;
    status: string;
    idempotencyKey?: string;
  }>
): string {
  const header = 'id,createdAt,stage,side,symbol,quantity,status,chainId,txHash,explorerUrl';
  const rows = (Array.isArray(intents) ? intents : []).map((item) => {
    const settlement = parseDexSettlementFromIdempotencyKey(item.idempotencyKey);
    return [
      escapeCsvCell(item.id),
      escapeCsvCell(item.createdAt || ''),
      escapeCsvCell(item.stage),
      escapeCsvCell(item.side),
      escapeCsvCell(item.symbol),
      escapeCsvCell(item.quantity),
      escapeCsvCell(item.status),
      escapeCsvCell(settlement?.chainId ?? ''),
      escapeCsvCell(settlement?.txHash ?? ''),
      escapeCsvCell(settlement?.explorerUrl ?? ''),
    ].join(',');
  });
  return [header, ...rows].join('\n');
}

export interface DexTokenPreset {
  symbol: string;
  name: string;
  address: string;
  chainId: number;
  decimals?: number;
}

/**
 * Authoritative 6-Chain Blue-Chip DEX Token Presets (Phase BA + BD).
 * Every address is a verified 42-char checksummed EVM contract on its canonical network.
 */
export const EVM_DEX_TOKEN_PRESETS: Record<number, DexTokenPreset[]> = {
  8453: [
    { symbol: 'USDC', name: 'USD Coin (Base)', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', chainId: 8453, decimals: 6 },
    { symbol: 'AERO', name: 'Aerodrome Finance', address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', chainId: 8453, decimals: 18 },
    { symbol: 'DEGEN', name: 'Degen (Base)', address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', chainId: 8453, decimals: 18 },
    { symbol: 'cbBTC', name: 'Coinbase Wrapped BTC', address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', chainId: 8453, decimals: 8 },
  ],
  42161: [
    { symbol: 'USDC', name: 'USD Coin (Arbitrum)', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', chainId: 42161, decimals: 6 },
    { symbol: 'ARB', name: 'Arbitrum', address: '0x912CE59144191C1204E64559FE8253a0e49E6548', chainId: 42161, decimals: 18 },
    { symbol: 'USDT', name: 'Tether USD (Arbitrum)', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', chainId: 42161, decimals: 6 },
    { symbol: 'GMX', name: 'GMX', address: '0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a', chainId: 42161, decimals: 18 },
  ],
  1: [
    { symbol: 'USDC', name: 'USD Coin (Ethereum)', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', chainId: 1, decimals: 6 },
    { symbol: 'USDT', name: 'Tether USD (Ethereum)', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', chainId: 1, decimals: 6 },
    { symbol: 'UNI', name: 'Uniswap', address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', chainId: 1, decimals: 18 },
    { symbol: 'LINK', name: 'Chainlink', address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', chainId: 1, decimals: 18 },
  ],
  10: [
    { symbol: 'USDC', name: 'USD Coin (Optimism)', address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', chainId: 10, decimals: 6 },
    { symbol: 'OP', name: 'Optimism', address: '0x4200000000000000000000000000000000000042', chainId: 10, decimals: 18 },
    { symbol: 'USDT', name: 'Tether USD (Optimism)', address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', chainId: 10, decimals: 6 },
  ],
  137: [
    { symbol: 'USDC', name: 'USD Coin (Polygon)', address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', chainId: 137, decimals: 6 },
    { symbol: 'USDT', name: 'Tether USD (Polygon)', address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', chainId: 137, decimals: 6 },
    { symbol: 'AAVE', name: 'Aave (Polygon)', address: '0xD6DF932A45C0f255f85145f286eA0b292B21C90B', chainId: 137, decimals: 18 },
  ],
  56: [
    { symbol: 'USDT', name: 'Tether USD (BSC)', address: '0x55d398326f99059fF775485246999027B3197955', chainId: 56, decimals: 18 },
    { symbol: 'USDC', name: 'USD Coin (BSC)', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', chainId: 56, decimals: 18 },
    { symbol: 'CAKE', name: 'PancakeSwap Token', address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', chainId: 56, decimals: 18 },
  ],
};

export function getDexTokenPresetsForChain(chainId: number): DexTokenPreset[] {
  return EVM_DEX_TOKEN_PRESETS[chainId] || EVM_DEX_TOKEN_PRESETS[8453];
}

export function getDefaultDexTokenForChain(chainId: number): DexTokenPreset {
  const list = getDexTokenPresetsForChain(chainId);
  return list[0];
}

export function findDexTokenPresetByAddress(
  chainId: number,
  address: string | null | undefined
): DexTokenPreset | null {
  if (!address || typeof address !== 'string') return null;
  const norm = address.trim().toLowerCase();
  if (!norm) return null;
  const list = getDexTokenPresetsForChain(chainId);
  return list.find((p) => p.address.toLowerCase() === norm) || null;
}

/**
 * Resolves the exact atomic `sellAmount` for 0x Swap API v2 (`BUY` = 18-decimal native coin,
 * `SELL` = token-decimals-aware ERC-20 amount such as 6 for USDC/USDT or 8 for cbBTC).
 */
export function resolveDexSellAmountAtomic(params: {
  side: 'BUY' | 'SELL';
  quantity: number;
  chainId: number;
  tokenAddress: string;
  tokenDecimals?: number | null;
}): { sellAmountAtomic: string; sellTokenDecimals: number } {
  const safeQty = Number.isFinite(params.quantity) && params.quantity > 0 ? params.quantity : 0.01;
  let sellTokenDecimals = 18;
  if (params.side === 'SELL') {
    const explicit = Number(params.tokenDecimals);
    if (Number.isInteger(explicit) && explicit >= 2 && explicit <= 18) {
      sellTokenDecimals = explicit;
    } else {
      const preset = findDexTokenPresetByAddress(params.chainId, params.tokenAddress);
      sellTokenDecimals = preset?.decimals ?? 18;
    }
  }
  const fixedStr = safeQty.toFixed(Math.min(sellTokenDecimals, 8)).replace(/\.?0+$/, '') || '0.01';
  try {
    return {
      sellAmountAtomic: ethers.parseUnits(fixedStr, sellTokenDecimals).toString(),
      sellTokenDecimals,
    };
  } catch {
    return {
      sellAmountAtomic: ethers.parseUnits('0.01', sellTokenDecimals).toString(),
      sellTokenDecimals,
    };
  }
}

export function formatDexQuoteOutputSummary(params: {
  side: 'BUY' | 'SELL';
  chainId: number;
  tokenAddress?: string | null;
  buyAmountAtomic?: string | null;
  minBuyAmountAtomic?: string | null;
}): {
  buyTokenSymbol: string;
  buyTokenDecimals: number;
  estimatedOutFormatted: string;
  minOutFormatted: string;
} {
  let buyTokenSymbol = 'TOKEN';
  let buyTokenDecimals = 18;

  if (params.side === 'SELL') {
    const chainCfg = EVM_DEX_CHAINS[params.chainId] || SUPPORTED_BASE_CHAINS.BASE_MAINNET;
    buyTokenSymbol = chainCfg.nativeCurrency.symbol || 'ETH';
    buyTokenDecimals = chainCfg.nativeCurrency.decimals || 18;
  } else {
    const preset = findDexTokenPresetByAddress(params.chainId, params.tokenAddress);
    buyTokenSymbol = preset?.symbol || 'TOKEN';
    buyTokenDecimals = preset?.decimals ?? 18;
  }

  const formatAtomic = (raw?: string | null): string => {
    if (!raw || typeof raw !== 'string') return '0';
    try {
      const bi = BigInt(raw);
      if (bi <= 0n) return '0';
      const formatted = ethers.formatUnits(bi, buyTokenDecimals);
      const num = Number(formatted);
      if (!Number.isFinite(num) || num <= 0) return formatted;
      if (num >= 100) return num.toFixed(2);
      if (num >= 1) return num.toFixed(4).replace(/\.?0+$/, '');
      return num.toFixed(6).replace(/\.?0+$/, '');
    } catch {
      return '0';
    }
  };

  const estimatedOutFormatted = formatAtomic(params.buyAmountAtomic);
  const minOutFormatted = formatAtomic(params.minBuyAmountAtomic || params.buyAmountAtomic);

  return {
    buyTokenSymbol,
    buyTokenDecimals,
    estimatedOutFormatted,
    minOutFormatted,
  };
}

/**
 * Multi-Chain MetaMask Network Switcher for any supported 0x EVM DEX chain (Phase AT).
 * Leaves `ensureBaseNetwork()` untouched for Billing & Launchpad contracts.
 */
export async function ensureEvmNetwork(
  targetChainId: number
): Promise<{ success: boolean; chainId?: number; hexChainId?: string; error?: string }> {
  const ethereum = resolveBrowserEthereumProvider();
  if (!ethereum) {
    return { success: false, error: 'Dompet Web3 (MetaMask) tidak terdeteksi di browser ini.' };
  }
  const targetConfig = EVM_DEX_CHAINS[targetChainId];
  if (!targetConfig) {
    return { success: false, error: `UNSUPPORTED_EVM_CHAIN: Chain ID ${targetChainId} belum didukung.` };
  }

  try {
    const currentChainHex: string = await ethereum.request({ method: 'eth_chainId' });
    if (currentChainHex && currentChainHex.toLowerCase() === targetConfig.hexChainId.toLowerCase()) {
      return { success: true, chainId: targetConfig.chainId, hexChainId: currentChainHex.toLowerCase() };
    }

    try {
      await ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: targetConfig.hexChainId }],
      });
    } catch (switchErr: any) {
      if (isUnrecognizedChainError(switchErr)) {
        await ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [
            {
              chainId: targetConfig.hexChainId,
              chainName: targetConfig.name,
              nativeCurrency: targetConfig.nativeCurrency,
              rpcUrls: [targetConfig.rpcUrl],
              blockExplorerUrls: [targetConfig.explorerUrl],
            },
          ],
        });
      } else if (switchErr?.code === 4001) {
        return { success: false, error: `USER_REJECTED: Pengguna menolak pindah ke ${targetConfig.name}.` };
      } else {
        throw switchErr;
      }
    }

    return { success: true, chainId: targetConfig.chainId, hexChainId: targetConfig.hexChainId };
  } catch (err: any) {
    return { success: false, error: err?.message || `Gagal berpindah ke ${targetConfig.name}.` };
  }
}

/**
 * Instantiates the BondingCurveLaunchpad contract with a verified deployment address.
 * Throws an explicit error if the contract is not verified or blocked.
 */
export function getLaunchpadContract(
  signerOrProvider: ethers.Signer | ethers.Provider,
  overrideAddress?: string | null
): ethers.Contract {
  const config = getContractConfiguration(overrideAddress);
  if (!config.isConfigured || !config.contractAddress) {
    throw new Error(config.message);
  }
  return new ethers.Contract(config.contractAddress, BONDING_CURVE_LAUNCHPAD_ABI, signerOrProvider);
}

/**
 * Normalizes Web3 and RPC errors into actionable user-facing messages.
 */
export function normalizeWeb3Error(error: any): string {
  if (!error) return 'Terjadi kesalahan transaksi yang tidak diketahui.';

  const msg = typeof error === 'string' ? error : error?.message || error?.reason || '';
  const code = error?.code;

  if (code === 4001 || code === 'ACTION_REJECTED' || msg.includes('user rejected') || msg.includes('User rejected')) {
    return 'Transaksi dibatalkan oleh pengguna di MetaMask.';
  }

  if (msg.includes('insufficient funds') || code === 'INSUFFICIENT_FUNDS') {
    return 'Saldo ETH tidak mencukupi untuk membayar biaya gas atau harga pembelian.';
  }

  if (msg.includes('BLOCKED')) {
    return msg;
  }

  if (msg.includes('INVALID_BOUNTY_PROOF') || msg.includes('INVALID_MERKLE_PROOF')) {
    return 'Verifikasi Merkle Proof gagal: Dompet atau alokasi tidak terdaftar dalam whitelist kampanye.';
  }

  if (msg.includes('FAIR_LAUNCH_BUY_LIMIT_EXCEEDED')) {
    return 'Pembelian melebihi batas alokasi maksimum per-dompet (Fair Launch Anti-Bot Limit).';
  }

  if (msg.includes('Bounty reward already claimed')) {
    return 'Alokasi bounty sudah pernah diklaim sebelumnya oleh dompet ini.';
  }

  if (msg.includes('Ownable: caller is not the owner')) {
    return 'Akses ditolak: Operasi ini membutuhkan otoritas Platform Admin / Contract Owner.';
  }

  if (msg.includes('TIMELOCK_ACTIVE')) {
    return 'Likuiditas masih terkunci on-chain selama periode anti-rugpull 180 hari.';
  }

  return msg.length > 120 ? msg.substring(0, 120) + '...' : msg;
}

/**
 * Generates an explorer link for a transaction hash or address on Base.
 */
export function getExplorerUrl(
  hashOrAddress: string,
  targetChainHex: string = '0x2105',
  type: 'tx' | 'address' = 'tx'
): string {
  const norm = targetChainHex.toLowerCase();
  if (norm.includes('robinhood') || norm === '0x1237' || norm === '4663') {
    return `https://robinhoodchain.blockscout.com/${type}/${hashOrAddress}`;
  }
  const isSepolia = norm === '0x14a34';
  const baseUrl = isSepolia ? 'https://sepolia.basescan.org' : 'https://basescan.org';
  return `${baseUrl}/${type}/${hashOrAddress}`;
}
