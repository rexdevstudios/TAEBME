/**
 * packages/launchpad/chain-event-mirror.ts
 *
 * Stateless, Idempotent On-Chain Event Mirror Engine (Phase FN).
 * - Decodes BondingCurveLaunchpad.sol events (`TokenCreated`, `TokenPurchased`, `TokenGraduated`) via viem.
 * - Uses deterministic SHA-256 UUIDs for `chain_events.id` so `ON CONFLICT (id) DO NOTHING`
 *   guarantees atomic idempotency with ZERO database DDL migrations.
 * - Enforces finality lag (anti-reorg) and bounded `maxBlockSpan` for safe serverless `eth_getLogs`.
 */

import crypto from 'crypto';
import { decodeEventLog, formatEther, parseAbiItem, type Log } from 'viem';

export const LAUNCHPAD_EVENT_ABIS = [
  parseAbiItem(
    'event TokenCreated(address indexed tokenAddress, address indexed creator, string name, string symbol, uint256 totalSupply, uint8 mode, uint256 graduationThresholdWei)'
  ),
  parseAbiItem(
    'event TokenPurchased(address indexed tokenAddress, address indexed buyer, uint256 amountTokens, uint256 costWei, uint256 newTotalRaisedWei)'
  ),
  parseAbiItem(
    'event TokenGraduated(address indexed tokenAddress, uint256 totalRaisedWei, uint256 totalTokensSold)'
  ),
] as const;

export type MirroredLaunchpadEventName = 'TokenCreated' | 'TokenPurchased' | 'TokenGraduated';

export interface MirroredLaunchpadEvent {
  eventName: MirroredLaunchpadEventName;
  contractAddress: string;
  tokenAddress: string;
  blockNumber: bigint;
  txHash: string;
  logIndex: number;
  buyer?: string;
  creator?: string;
  amountTokensWei?: string;
  costWei?: string;
  newTotalRaisedWei?: string;
  totalRaisedWei?: string;
  totalTokensSoldWei?: string;
  name?: string;
  symbol?: string;
}

export interface BlockSyncWindow {
  fromBlock: bigint;
  toBlock: bigint;
  safeHead: bigint;
}

/**
 * Generates a deterministic RFC-4122-formatted UUID from `(networkId, txHash, logIndex)`.
 * Enables atomic `ON CONFLICT (id) DO NOTHING` idempotency on `public.chain_events` with 0 DDL changes.
 */
export function computeDeterministicChainEventId(
  networkId: string,
  txHash: string,
  logIndex: number
): string {
  const key = `${String(networkId || '').trim().toLowerCase()}:${String(txHash || '').trim().toLowerCase()}:${Math.max(0, Math.floor(Number(logIndex) || 0))}`;
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  // Format first 32 hex chars as UUID v5-style (version 5 nibble, RFC variant nibble)
  const p1 = hash.slice(0, 8);
  const p2 = hash.slice(8, 12);
  const p3 = `5${hash.slice(13, 16)}`;
  const variantNibble = ((parseInt(hash.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  const p4 = `${variantNibble}${hash.slice(17, 20)}`;
  const p5 = hash.slice(20, 32);
  return `${p1}-${p2}-${p3}-${p4}-${p5}`;
}

/**
 * Computes a bounded, reorg-safe incremental `[fromBlock, toBlock]` scan window.
 * Returns `null` when the cursor is already caught up to `safeHead`.
 */
export function computeIncrementalBlockWindow(params: {
  lastIndexedBlock: bigint | null;
  latestBlock: bigint;
  maxBlockSpan?: bigint;
  finalityLag?: bigint;
}): BlockSyncWindow | null {
  const maxSpan = params.maxBlockSpan && params.maxBlockSpan > 0n ? params.maxBlockSpan : 2000n;
  const lag = params.finalityLag !== undefined && params.finalityLag >= 0n ? params.finalityLag : 1n;
  const safeHead = params.latestBlock > lag ? params.latestBlock - lag : 0n;

  if (safeHead <= 0n && params.latestBlock === 0n) return null;

  let fromBlock: bigint;
  if (params.lastIndexedBlock === null) {
    fromBlock = safeHead >= maxSpan ? safeHead - maxSpan + 1n : 0n;
  } else {
    fromBlock = params.lastIndexedBlock + 1n;
  }

  if (fromBlock > safeHead) {
    return null;
  }

  const maxTo = fromBlock + maxSpan - 1n;
  const toBlock = maxTo < safeHead ? maxTo : safeHead;
  return { fromBlock, toBlock, safeHead };
}

/**
 * Pure viem ABI decoder for `BondingCurveLaunchpad.sol` event logs.
 * Returns `null` for unrecognized or malformed logs without throwing.
 */
export function decodeLaunchpadEventLog(log: {
  address?: string;
  data: `0x${string}`;
  topics: readonly `0x${string}`[];
  blockNumber?: bigint | null;
  transactionHash?: `0x${string}` | null;
  logIndex?: number | null;
}): MirroredLaunchpadEvent | null {
  if (!log.topics || log.topics.length === 0 || !log.transactionHash || log.blockNumber === null || log.blockNumber === undefined) {
    return null;
  }
  try {
    const decoded = decodeEventLog({
      abi: LAUNCHPAD_EVENT_ABIS,
      data: log.data,
      topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      strict: false,
    }) as { eventName?: string; args?: Record<string, any> };

    const args = (decoded.args || {}) as Record<string, any>;
    const tokenAddress = typeof args.tokenAddress === 'string' ? args.tokenAddress : '';
    if (!tokenAddress) return null;

    const base = {
      contractAddress: String(log.address || tokenAddress),
      tokenAddress,
      blockNumber: BigInt(log.blockNumber),
      txHash: String(log.transactionHash),
      logIndex: Number(log.logIndex ?? 0),
    };

    if (decoded.eventName === 'TokenPurchased') {
      return {
        ...base,
        eventName: 'TokenPurchased',
        buyer: typeof args.buyer === 'string' ? args.buyer : undefined,
        amountTokensWei: args.amountTokens !== undefined ? String(args.amountTokens) : undefined,
        costWei: args.costWei !== undefined ? String(args.costWei) : undefined,
        newTotalRaisedWei: args.newTotalRaisedWei !== undefined ? String(args.newTotalRaisedWei) : undefined,
      };
    }

    if (decoded.eventName === 'TokenGraduated') {
      return {
        ...base,
        eventName: 'TokenGraduated',
        totalRaisedWei: args.totalRaisedWei !== undefined ? String(args.totalRaisedWei) : undefined,
        totalTokensSoldWei: args.totalTokensSold !== undefined ? String(args.totalTokensSold) : undefined,
      };
    }

    if (decoded.eventName === 'TokenCreated') {
      return {
        ...base,
        eventName: 'TokenCreated',
        creator: typeof args.creator === 'string' ? args.creator : undefined,
        name: typeof args.name === 'string' ? args.name : undefined,
        symbol: typeof args.symbol === 'string' ? args.symbol : undefined,
      };
    }

    return null;
  } catch {
    return null;
  }
}

export function weiStringToEthNumber(weiStr?: string): number {
  if (!weiStr) return 0;
  try {
    const ethNum = Number(formatEther(BigInt(weiStr)));
    return Number.isFinite(ethNum) && ethNum >= 0 ? Math.round(ethNum * 1e6) / 1e6 : 0;
  } catch {
    return 0;
  }
}

/**
 * Persists decoded launchpad events idempotently into `chain_events` and mirrors
 * monotonic state updates (`raised_amount`, `is_graduated`) into `token_launches`.
 */
export async function applyMirroredEventsToPostgres(
  pool: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount?: number | null; rows: any[] }> },
  networkId: string,
  events: readonly MirroredLaunchpadEvent[]
): Promise<{ eventsInserted: number; launchesUpdated: number }> {
  let eventsInserted = 0;
  let launchesUpdated = 0;

  for (const ev of events) {
    const eventId = computeDeterministicChainEventId(networkId, ev.txHash, ev.logIndex);
    const eventPayload = {
      tokenAddress: ev.tokenAddress,
      logIndex: ev.logIndex,
      ...(ev.buyer ? { buyer: ev.buyer } : {}),
      ...(ev.creator ? { creator: ev.creator } : {}),
      ...(ev.amountTokensWei ? { amountTokensWei: ev.amountTokensWei } : {}),
      ...(ev.costWei ? { costWei: ev.costWei } : {}),
      ...(ev.newTotalRaisedWei ? { newTotalRaisedWei: ev.newTotalRaisedWei } : {}),
      ...(ev.totalRaisedWei ? { totalRaisedWei: ev.totalRaisedWei } : {}),
      ...(ev.totalTokensSoldWei ? { totalTokensSoldWei: ev.totalTokensSoldWei } : {}),
      ...(ev.name ? { name: ev.name } : {}),
      ...(ev.symbol ? { symbol: ev.symbol } : {}),
    };

    const insRes = await pool.query(
      `INSERT INTO chain_events (
         id, network_id, block_number, tx_hash, event_name, contract_address, event_data, indexed_at
       ) VALUES ($1::uuid, $2, $3::bigint, $4, $5, $6, $7::jsonb, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [
        eventId,
        networkId,
        ev.blockNumber.toString(),
        ev.txHash,
        ev.eventName,
        ev.contractAddress,
        JSON.stringify(eventPayload),
      ]
    );
    if ((insRes.rowCount ?? 0) > 0) {
      eventsInserted += 1;
    }

    if (ev.eventName === 'TokenPurchased' && ev.newTotalRaisedWei) {
      const raisedEth = weiStringToEthNumber(ev.newTotalRaisedWei);
      const updRes = await pool.query(
        `UPDATE token_launches
         SET raised_amount = GREATEST(COALESCE(raised_amount, 0), $1::numeric)
         WHERE LOWER(contract_address) = LOWER($2)`,
        [raisedEth, ev.tokenAddress]
      );
      if ((updRes.rowCount ?? 0) > 0) launchesUpdated += 1;
    } else if (ev.eventName === 'TokenGraduated') {
      const raisedEth = weiStringToEthNumber(ev.totalRaisedWei);
      const updRes = await pool.query(
        `UPDATE token_launches
         SET is_graduated = true,
             graduated_at = COALESCE(graduated_at, NOW()),
             raised_amount = GREATEST(COALESCE(raised_amount, 0), $1::numeric)
         WHERE LOWER(contract_address) = LOWER($2)`,
        [raisedEth, ev.tokenAddress]
      );
      if ((updRes.rowCount ?? 0) > 0) launchesUpdated += 1;
    }
  }

  return { eventsInserted, launchesUpdated };
}
