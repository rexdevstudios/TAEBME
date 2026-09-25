import { NextRequest, NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { defaultBountyDbAdapter, getDbPool } from '@/packages/shared/db-pool';
import { authenticateSession } from '@packages/auth/session';

function isUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

export async function POST(req: NextRequest) {
  try {
    // C-02 Fix: Settle requires an authenticated session.
    // Any verified wallet (TRADER+) can settle their own claim via this endpoint.
    const session = await authenticateSession(req);
    if (!session) {
      return NextResponse.json(
        { success: false, error: 'UNAUTHORIZED: Valid SIWE session required to settle a claim.' },
        { status: 401 }
      );
    }

    const body = await req.json();
    const { claimId, txHash, chain } = body;

    // 1. Input Validation
    if (!claimId || !isUuid(claimId)) {
      return NextResponse.json(
        { success: false, error: 'INVALID_CLAIM_ID: Format UUID klaim tidak valid.' },
        { status: 400 }
      );
    }

    if (!txHash || !ethers.isHexString(txHash, 32)) {
      return NextResponse.json(
        { success: false, error: 'INVALID_TX_HASH: Hash transaksi harus berformat 32-byte hex (0x...).' },
        { status: 400 }
      );
    }

    // 2. C-02 Fix: Verify claim ownership + settlement state before any on-chain call.
    // Schema: bounty_claims.kol_id → kol_profiles.id → kol_profiles.user_id (wallet address).
    // kol_profiles.user_id is set to walletAddress at claim submission time (claim/route.ts:120+144).
    const pool = getDbPool();
    if (!pool) {
      // Cannot verify ownership without DB — fail-closed in all environments.
      return NextResponse.json(
        { success: false, error: 'DB_UNAVAILABLE: Cannot verify claim ownership. Please retry later.' },
        { status: 503 }
      );
    }

    const ownershipRes = await pool.query(
      `SELECT bc.verification_status,
              bc.tx_hash,
              kp.user_id AS kol_user_id
       FROM bounty_claims bc
       JOIN kol_profiles kp ON kp.id = bc.kol_id
       WHERE bc.id = $1
       LIMIT 1`,
      [claimId]
    );

    if (ownershipRes.rows.length === 0) {
      return NextResponse.json(
        { success: false, error: 'CLAIM_NOT_FOUND: Klaim tidak ditemukan.' },
        { status: 404 }
      );
    }

    const claimRow = ownershipRes.rows[0];

    // Wallet identity: kol_profiles.user_id holds the wallet address (set by claim route).
    if (claimRow.kol_user_id.toLowerCase() !== session.walletAddress.toLowerCase()) {
      return NextResponse.json(
        { success: false, error: 'FORBIDDEN: Anda tidak berwenang untuk menyelesaikan klaim ini.' },
        { status: 403 }
      );
    }

    // Claim must be VERIFIED (off-chain proof accepted) before on-chain settlement.
    if (claimRow.verification_status !== 'VERIFIED') {
      return NextResponse.json(
        { success: false, error: `INVALID_CLAIM_STATE: Klaim harus berstatus VERIFIED. Status saat ini: ${claimRow.verification_status}` },
        { status: 400 }
      );
    }

    // H-06: tx_hash IS NULL check — prevent double-settle at application layer.
    // The DB UNIQUE(tx_hash) constraint is the safety net; this is the first gate.
    if (claimRow.tx_hash !== null) {
      return NextResponse.json(
        { success: false, error: 'ALREADY_SETTLED: Klaim ini sudah diselesaikan sebelumnya.' },
        { status: 409 }
      );
    }

    // 3. Multi-Chain RPC Node Selection
    const isRobinhood =
      String(chain || '').toLowerCase().includes('robinhood') ||
      String(chain || '').toLowerCase() === '0x1237' ||
      String(chain || '') === '4663';

    const rpcUrl = isRobinhood
      ? 'https://rpc.mainnet.chain.robinhood.com'
      : 'https://mainnet.base.org';

    let blockNumber: number | undefined;

    // 4. C-02 Fix: On-Chain Receipt Verification is BLOCKING.
    // RPC failure rejects the settle — do not settle without confirmed tx receipt.
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt) {
        return NextResponse.json(
          { success: false, error: 'TX_NOT_FOUND: Transaksi tidak ditemukan di blockchain. Tunggu konfirmasi dan coba lagi.' },
          { status: 400 }
        );
      }
      if (receipt.status === 0) {
        return NextResponse.json(
          { success: false, error: 'TRANSACTION_REVERTED_ONCHAIN: Transaksi gagal dieksekusi di blockchain.' },
          { status: 400 }
        );
      }
      blockNumber = receipt.blockNumber;
    } catch (rpcErr: any) {
      console.error('[POST /api/launchpad/bounty/settle] RPC verification failed (blocking):', rpcErr?.message);
      return NextResponse.json(
        { success: false, error: 'RPC_UNAVAILABLE: Cannot verify transaction on-chain. Please retry later.' },
        { status: 503 }
      );
    }

    // 5. Settle Claim Idempotently in PostgreSQL SSOT
    // settleClaimOnChain uses a conditional UPDATE (verification_status='VERIFIED' AND tx_hash IS NULL)
    // and persists tx_hash — any concurrent race that passes the checks above will be caught at DB level.
    await defaultBountyDbAdapter.settleClaimOnChain?.(claimId, txHash, blockNumber);

    return NextResponse.json({
      success: true,
      message: 'Klaim reward SocialFi berhasil diselesaikan on-chain.',
      data: {
        claimId,
        txHash,
        blockNumber: blockNumber || null,
        status: 'CLAIMED',
        settledAt: new Date().toISOString(),
      },
    });
  } catch (err: any) {
    console.error('[POST /api/launchpad/bounty/settle] Error:', err);
    return NextResponse.json(
      { success: false, error: err?.message || 'INTERNAL_SERVER_ERROR' },
      { status: 500 }
    );
  }
}
