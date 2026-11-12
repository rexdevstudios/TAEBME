import { NextRequest, NextResponse } from 'next/server';
import { GaslessPaymasterService } from '@/packages/launchpad/gasless-paymaster';
import { ethers } from 'ethers';
import { authenticateSession } from '@packages/auth/session';
import { rateLimiter } from '@packages/auth/rate-limiter';
import { getDbPool } from '@/packages/shared/db-pool';

export async function POST(req: NextRequest) {
  try {
    // 1. Mandatory SIWE Session Authentication
    const session = await authenticateSession(req);
    if (!session) {
      return NextResponse.json(
        { success: false, error: 'UNAUTHORIZED: Valid SIWE session required.' },
        { status: 401 }
      );
    }

    // 2. Strict Rate Limiting (3 requests / hour / wallet, FAIL_CLOSED)
    const rateLimitKey = `ratelimit:paymaster:${session.walletAddress.toLowerCase()}`;
    const rateCheck = await rateLimiter.checkRateLimit(rateLimitKey, 3, 3600, 'FAIL_CLOSED');
    if (!rateCheck.allowed) {
      if (rateCheck.error === 'RATE_LIMITER_UNAVAILABLE') {
        return NextResponse.json(
          { success: false, error: 'RATE_LIMITER_UNAVAILABLE: Rate limiting service temporarily unavailable.' },
          { status: 503 }
        );
      }
      return NextResponse.json(
        { success: false, error: 'RATE_LIMIT_EXCEEDED: Paymaster sponsorship limit exceeded (max 3 per hour).' },
        { status: 429 }
      );
    }

    const body = await req.json();
    const { tokenAddress, kolWallet, tokenAmount, chainId } = body;

    // 3. Wallet Address Validation & Identity Binding
    if (!kolWallet || !ethers.isAddress(kolWallet)) {
      return NextResponse.json(
        { success: false, error: 'INVALID_KOL_WALLET: Valid KOL wallet address required' },
        { status: 400 }
      );
    }

    if (ethers.getAddress(kolWallet) !== ethers.getAddress(session.walletAddress)) {
      return NextResponse.json(
        { success: false, error: 'FORBIDDEN: kolWallet must match authenticated wallet address' },
        { status: 403 }
      );
    }

    // 4. Chain ID Lock (Base Mainnet 8453 only)
    if (chainId !== undefined && Number(chainId) !== 8453) {
      return NextResponse.json(
        { success: false, error: 'UNSUPPORTED_CHAIN: Paymaster sponsorship is only supported on Base Mainnet (chainId 8453)' },
        { status: 400 }
      );
    }

    // 5. Token Address Format Validation
    if (!tokenAddress || !ethers.isAddress(tokenAddress)) {
      return NextResponse.json(
        { success: false, error: 'INVALID_TOKEN_ADDRESS: Valid token address required' },
        { status: 400 }
      );
    }

    // 6. Token Amount Validation
    let parsedAmount: bigint;
    try {
      parsedAmount = BigInt(tokenAmount);
      if (parsedAmount <= 0n) throw new Error();
    } catch {
      return NextResponse.json(
        { success: false, error: 'INVALID_AMOUNT: Positive token amount required' },
        { status: 400 }
      );
    }

    // 7. Database Verification: Token Launch Exists & Claimant Has Eligible Claim
    const pool = getDbPool();
    if (!pool) {
      return NextResponse.json(
        { success: false, error: 'DB_UNAVAILABLE: Database connection pool unavailable' },
        { status: 503 }
      );
    }

    const launchRes = await pool.query(
      `SELECT id FROM token_launches WHERE LOWER(contract_address) = LOWER($1) LIMIT 1`,
      [tokenAddress]
    );

    if (launchRes.rows.length === 0) {
      return NextResponse.json(
        { success: false, error: 'TOKEN_NOT_FOUND: Token is not a recognized launchpad token' },
        { status: 400 }
      );
    }

    const claimRes = await pool.query(
      `SELECT bc.id, bc.verification_status
       FROM bounty_claims bc
       JOIN bounty_campaigns bcamp ON bcamp.id = bc.campaign_id
       JOIN token_launches tl ON tl.id = bcamp.launch_id
       JOIN kol_profiles kp ON kp.id = bc.kol_id
       LEFT JOIN wallets w ON w.user_id = kp.user_id
       WHERE LOWER(tl.contract_address) = LOWER($1)
         AND (LOWER(w.address) = LOWER($2) OR LOWER(kp.user_id::text) = LOWER($2))
         AND bc.verification_status IN ('VERIFIED', 'APPROVED')
         AND bc.tx_hash IS NULL
       LIMIT 1`,
      [tokenAddress, session.walletAddress]
    );

    if (claimRes.rows.length === 0) {
      return NextResponse.json(
        { success: false, error: 'NO_ELIGIBLE_CLAIM: No verified and unsettled claim found for this token and wallet' },
        { status: 403 }
      );
    }

    // 8. Sign Sponsorship Quote via Remote Signer (No private key in Vercel)
    const paymasterService = new GaslessPaymasterService({
      defaultChainId: 8453,
    });

    const quote = await paymasterService.signSponsorship(
      tokenAddress,
      kolWallet,
      parsedAmount,
      3600, // 1 hour validity
      8453
    );

    return NextResponse.json({
      success: true,
      data: quote,
    });
  } catch (error: any) {
    console.error('[POST /api/paymaster/sponsor] Error:', error);
    const message = error?.message || 'PAYMASTER_SPONSORSHIP_FAILED';
    const isSignerUnavailable =
      message.includes('PAYMASTER_SIGNER_UNCONFIGURED') ||
      message.includes('PAYMASTER_SIGNER_UNAVAILABLE') ||
      message.includes('SERVICE_UNAVAILABLE');

    return NextResponse.json(
      { success: false, error: message },
      { status: isSignerUnavailable ? 503 : 500 }
    );
  }
}
