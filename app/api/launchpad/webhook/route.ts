import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/packages/shared/db-pool';
import crypto from 'crypto';
import { ethers } from 'ethers';

/**
 * Verifies webhook caller authenticity.
 * Requires non-empty WEBHOOK_SECRET / FAST_TRACK_WEBHOOK_SECRET in headers or Alchemy HMAC SHA-256 signature.
 * Note: Query parameter authentication (?secret=) is strictly disallowed to prevent log leakage and empty matching.
 */
function isWebhookAuthorized(req: NextRequest, rawBody?: string): boolean {
  const rawSecret = process.env.WEBHOOK_SECRET || process.env.FAST_TRACK_WEBHOOK_SECRET;
  const secret = rawSecret?.trim();
  const alchemySigningKey = (process.env.ALCHEMY_WEBHOOK_SIGNING_KEY || process.env.WEBHOOK_SECRET)?.trim();

  // Fail closed unconditionally if neither secret nor alchemy key is configured
  if (!secret && !alchemySigningKey) {
    return false;
  }

  // 1. Alchemy HMAC SHA-256 signature verification (Preferred for Alchemy Notify)
  const alchemySignature = req.headers.get('x-alchemy-signature');
  if (alchemySignature && alchemySigningKey && rawBody) {
    try {
      const hmac = crypto.createHmac('sha256', alchemySigningKey);
      hmac.update(rawBody, 'utf8');
      const digest = hmac.digest('hex');
      const expectedBuf = Buffer.from(digest);
      const receivedBuf = Buffer.from(alchemySignature);
      if (expectedBuf.length === receivedBuf.length && crypto.timingSafeEqual(expectedBuf, receivedBuf)) {
        return true;
      }
    } catch {
      // Fall through on HMAC parse/compare error
    }
  }

  // 2. Secret-based header authentication (Secret must be at least 16 characters)
  if (secret && secret.length >= 16) {
    // Check custom headers
    const headerSecret = req.headers.get('x-webhook-secret') || req.headers.get('x-api-key');
    if (headerSecret && headerSecret === secret) return true;

    // Check Bearer authorization header
    const authHeader = req.headers.get('authorization');
    if (authHeader && authHeader === `Bearer ${secret}`) return true;
  }

  return false;
}

export async function GET(req: NextRequest) {
  return NextResponse.json({
    status: 'ACTIVE',
    service: 'RTrader On-Chain Real-Time Webhook Gateway',
    timestamp: new Date().toISOString(),
    supportedProtocols: ['Alchemy Notify', 'DexScreener Fast-Track', 'Custom EVM Event Stream'],
  });
}

export async function POST(req: NextRequest) {
  const startTime = performance.now();
  let rawBody = '';

  try {
    rawBody = await req.text();
  } catch {
    return NextResponse.json(
      { success: false, error: 'BAD_REQUEST: Empty or unreadable body payload' },
      { status: 400 }
    );
  }

  if (!isWebhookAuthorized(req, rawBody)) {
    return NextResponse.json(
      {
        success: false,
        error: 'UNAUTHORIZED: Valid webhook signature or secret required',
        timestamp: new Date().toISOString(),
      },
      { status: 401 }
    );
  }

  let payload: any = {};
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { success: false, error: 'INVALID_JSON: Body is not valid JSON' },
      { status: 400 }
    );
  }

  try {
    const eventsToPersist: Array<{
      networkId: string;
      blockNumber: number;
      txHash: string;
      eventName: string;
      contractAddress: string;
      eventData: any;
    }> = [];

    // Case 1: Alchemy Notify webhook payload format
    if (payload.event && Array.isArray(payload.event.activity)) {
      const network = payload.event.network || 'base-mainnet';
      for (const act of payload.event.activity) {
        const contractAddr = act.rawContract?.address || act.contractAddress || act.toAddress || '0x0000000000000000000000000000000000000000';
        eventsToPersist.push({
          networkId: network.toLowerCase(),
          blockNumber: parseInt(act.blockNum || '0', 16) || Number(act.blockNumber || 0),
          txHash: act.hash || act.txHash || `0x${crypto.randomBytes(32).toString('hex')}`,
          eventName: act.category?.toUpperCase() || 'ALCHEMY_ACTIVITY',
          contractAddress: ethers.isAddress(contractAddr) ? ethers.getAddress(contractAddr) : contractAddr,
          eventData: act,
        });
      }
    }
    // Case 2: Generic or internal direct on-chain event format
    else {
      const networkId = payload.networkId || payload.network || 'base-mainnet';
      const blockNumber = Number(payload.blockNumber || payload.block || 0);
      const txHash = payload.txHash || payload.hash || `0x${crypto.randomBytes(32).toString('hex')}`;
      const eventName = (payload.eventName || payload.event || 'ON_CHAIN_EVENT').toUpperCase();
      const rawContract = payload.contractAddress || payload.address || '0x0000000000000000000000000000000000000000';
      const contractAddress = ethers.isAddress(rawContract) ? ethers.getAddress(rawContract) : rawContract;
      const eventData = payload.eventData || payload.data || payload;

      eventsToPersist.push({
        networkId,
        blockNumber,
        txHash,
        eventName,
        contractAddress,
        eventData,
      });
    }

    // Persist each event into Neon PostgreSQL `chain_events` table (advisory / observability only)
    const persistedIds: string[] = [];

    for (const ev of eventsToPersist) {
      const eventUuid = crypto.randomUUID();
      await query(
        `INSERT INTO chain_events (
          id, network_id, block_number, tx_hash, event_name, contract_address, event_data, indexed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        ON CONFLICT DO NOTHING`,
        [
          eventUuid,
          ev.networkId,
          ev.blockNumber,
          ev.txHash,
          ev.eventName,
          ev.contractAddress,
          JSON.stringify(ev.eventData),
        ]
      );
      persistedIds.push(eventUuid);
    }

    const elapsedMs = Math.round(performance.now() - startTime);

    return NextResponse.json(
      {
        success: true,
        data: {
          processedCount: eventsToPersist.length,
          persistedIds,
          elapsedMs,
          timestamp: new Date().toISOString(),
        },
      },
      { status: 201 }
    );
  } catch (err: any) {
    return NextResponse.json(
      {
        success: false,
        error: `WEBHOOK_INGESTION_FAILED: ${err.message || String(err)}`,
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
