import { NextRequest, NextResponse } from 'next/server';
import { ApiResponse } from '@packages/shared/contracts/api-contracts';
import { defaultDraftDbAdapter } from '@packages/shared/db-pool';
import { DexPairFactoryService } from '@packages/launchpad/dex-pair-factory';
import { requireCapability } from '@packages/auth/session';
import { verifyEvmTransactionReceipt } from '@packages/launchpad/evm-verifier';
import { ethers } from 'ethers';

export const dynamic = 'force-dynamic';

function isUuid(id?: string): boolean {
  if (!id) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

export async function POST(req: NextRequest) {
  try {
    // C-01 Fix: Graduate is an admin/indexer-only operation.
    // Requires SUPER_ADMIN or LAUNCH_ADMIN role via RBAC.
    await requireCapability(req, 'GRADUATE_LAUNCH');

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const { launchId, contractAddress, txHash, chain, raisedAmount } = body;

    if (!launchId && !contractAddress) {
      const response: ApiResponse<null> = {
        success: false,
        error: {
          code: 'MISSING_PARAMETERS',
          message: 'Harap sediakan launchId (UUID) atau contractAddress (0x...) yang valid.',
        },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(response, { status: 400 });
    }

    if (contractAddress && !ethers.isAddress(contractAddress)) {
      const response: ApiResponse<null> = {
        success: false,
        error: {
          code: 'INVALID_CONTRACT_ADDRESS',
          message: 'contractAddress harus berupa alamat Ethereum/EVM 20-byte yang sah.',
        },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(response, { status: 400 });
    }

    if (launchId && !isUuid(launchId)) {
      const response: ApiResponse<null> = {
        success: false,
        error: {
          code: 'INVALID_LAUNCH_ID',
          message: 'launchId harus berformat UUID v4.',
        },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(response, { status: 400 });
    }

    if (!txHash || typeof txHash !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
      const response: ApiResponse<null> = {
        success: false,
        error: {
          code: 'MISSING_MIGRATION_TX_HASH',
          message: 'txHash transaksi migrasi on-chain yang valid (64 hex characters) wajib disertakan.',
        },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(response, { status: 400 });
    }

    // 1. Resolve expected contract address from DB to verify event emitter
    const targetChain = chain || 'base-mainnet';
    let expectedAddress = contractAddress ? ethers.getAddress(contractAddress).toLowerCase() : null;

    if (!expectedAddress && launchId) {
      const existingLaunch = await defaultDraftDbAdapter.getLaunchDraftById?.(launchId);
      if (existingLaunch?.contractAddress) {
        expectedAddress = ethers.getAddress(existingLaunch.contractAddress).toLowerCase();
      }
    }

    if (!expectedAddress) {
      // Look up by address or ID
      const existing = await defaultDraftDbAdapter.getTokenLaunchByAddress?.(targetChain, contractAddress || '');
      if (existing?.contractAddress) {
        expectedAddress = ethers.getAddress(existing.contractAddress).toLowerCase();
      }
    }

    // 2. On-chain EVM Verification: Verify migration transaction receipt and extract pair address from logs
    const receiptResult = await verifyEvmTransactionReceipt(txHash, targetChain);
    if (receiptResult.status !== 'confirmed' || !receiptResult.receipt) {
      const response: ApiResponse<null> = {
        success: false,
        error: {
          code: 'INVALID_ONCHAIN_MIGRATION',
          message: `Transaksi migrasi gagal atau belum terkonfirmasi on-chain: ${receiptResult.reason || receiptResult.status}`,
        },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(response, { status: 422 });
    }

    // Canonical event signature from LaunchpadStorage.sol / BondingCurveLaunchpadCore.sol
    // event LiquidityMigrated(address indexed pool, uint256 poolTokens, uint256 poolEth, uint256 feeEth, address indexed treasury, address indexed lpRecipient);
    const topicLiquidityMigrated = ethers.id('LiquidityMigrated(address,uint256,uint256,uint256,address,address)');

    let verifiedDexPairAddress: string | null = null;
    let foundWrongEmitter = false;
    const logs = (receiptResult.receipt.logs || []) as { address?: string; topics?: string[]; data?: string }[];

    for (const log of logs) {
      const t0 = log.topics?.[0]?.toLowerCase();
      if (t0 === topicLiquidityMigrated.toLowerCase()) {
        const emitter = log.address ? ethers.getAddress(log.address).toLowerCase() : null;
        if (expectedAddress && emitter !== expectedAddress) {
          foundWrongEmitter = true;
          continue; // Emitter does not match expected Launchpad contract
        }

        // Extract indexed pool address from topic 1
        if (log.topics && log.topics[1] && log.topics[1].length === 66) {
          try {
            const rawPool = '0x' + log.topics[1].slice(26);
            if (ethers.isAddress(rawPool) && rawPool !== ethers.ZeroAddress) {
              verifiedDexPairAddress = ethers.getAddress(rawPool);
              break;
            }
          } catch {}
        }
      }
    }

    if (!verifiedDexPairAddress) {
      const response: ApiResponse<null> = {
        success: false,
        error: {
          code: 'INVALID_ONCHAIN_MIGRATION',
          message: foundWrongEmitter
            ? 'Event emitter LiquidityMigrated tidak cocok dengan alamat Launchpad Core yang sah.'
            : 'Receipt transaksi migrasi tidak memuat event log LiquidityMigrated yang sah dari Launchpad Core.',
        },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(response, { status: 422 });
    }

    if (!defaultDraftDbAdapter.graduateTokenLaunch) {
      throw new Error('graduateTokenLaunch adapter method not implemented.');
    }

    const result = await defaultDraftDbAdapter.graduateTokenLaunch({
      launchId,
      contractAddress: expectedAddress ? ethers.getAddress(expectedAddress) : contractAddress,
      dexPairAddress: verifiedDexPairAddress,
      raisedAmount: raisedAmount ? Number(raisedAmount) : undefined,
    });

    const pairDetails = DexPairFactoryService.getDexPairDetails(
      targetChain,
      result.contractAddress,
      result.dexPairAddress
    );


    const response: ApiResponse<{
      launchId: string;
      contractAddress: string;
      dexPairAddress: string;
      isGraduated: boolean;
      graduatedAt: string;
      dexDetails: typeof pairDetails;
    }> = {
      success: true,
      data: {
        launchId: result.launchId,
        contractAddress: result.contractAddress,
        dexPairAddress: result.dexPairAddress,
        isGraduated: result.isGraduated,
        graduatedAt: result.graduatedAt.toISOString(),
        dexDetails: pairDetails,
      },
      timestamp: new Date().toISOString(),
    };

    return NextResponse.json(response, { status: 200 });
  } catch (err: any) {
    console.error('[POST /api/launchpad/graduate] Error:', err);
    // requireCapability throws errors prefixed UNAUTHORIZED / RBAC_FORBIDDEN / AUTH_ACCOUNT_
    const isUnauthorized = err?.message?.startsWith('UNAUTHORIZED');
    const isForbidden = err?.message?.startsWith('RBAC_FORBIDDEN') || err?.message?.startsWith('AUTH_ACCOUNT_');
    const response: ApiResponse<null> = {
      success: false,
      error: { code: 'GRADUATION_FAILED', message: err?.message || 'Graduation trigger failed' },
      timestamp: new Date().toISOString(),
    };
    return NextResponse.json(response, { status: isUnauthorized ? 401 : isForbidden ? 403 : 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const contractAddress = searchParams.get('contractAddress') || searchParams.get('address');
    const chain = searchParams.get('chain') || 'base';

    if (!contractAddress || !ethers.isAddress(contractAddress)) {
      return NextResponse.json(
        {
          success: false,
          error: { code: 'INVALID_QUERY', message: 'Parameter query ?contractAddress= valid diperlukan.' },
          timestamp: new Date().toISOString(),
        },
        { status: 400 }
      );
    }

    const tokenLaunch = await defaultDraftDbAdapter.getTokenLaunchByAddress?.(chain, contractAddress);

    if (!tokenLaunch) {
      return NextResponse.json(
        {
          success: false,
          error: { code: 'NOT_FOUND', message: 'Token launch tidak ditemukan di database.' },
          timestamp: new Date().toISOString(),
        },
        { status: 404 }
      );
    }

    const raised = Number(tokenLaunch.raisedAmount || 0);
    const threshold = Number(tokenLaunch.graduationThreshold || 69000);
    const isReadyForGraduation = raised >= threshold;
    const progressPct = Math.min(100, Math.round((raised / threshold) * 100));

    const dexDetails = DexPairFactoryService.getDexPairDetails(
      tokenLaunch.chain || chain,
      contractAddress,
      tokenLaunch.dexPairAddress
    );

    return NextResponse.json(
      {
        success: true,
        data: {
          contractAddress: tokenLaunch.contractAddress,
          chain: tokenLaunch.chain,
          name: tokenLaunch.name,
          ticker: tokenLaunch.ticker,
          raisedAmount: raised,
          graduationThreshold: threshold,
          progressPct,
          isGraduated: Boolean(tokenLaunch.isGraduated),
          isReadyForGraduation,
          dexPairAddress: tokenLaunch.dexPairAddress || dexDetails.dexPairAddress,
          dexDetails,
        },
        timestamp: new Date().toISOString(),
      },
      { status: 200 }
    );
  } catch (err: any) {
    return NextResponse.json(
      {
        success: false,
        error: { code: 'LOOKUP_FAILED', message: err?.message || 'Failed to inspect graduation status' },
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
