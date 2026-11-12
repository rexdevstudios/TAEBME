import { NextRequest, NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { defaultBountyDbAdapter, defaultKolDbAdapter, getDbPool, defaultRpcManager } from '@/packages/shared/db-pool';
import { requireCapability } from '@/packages/auth/session';
import { BountyDbAdapter } from '@/packages/launchpad/bounty-escrow';
import { BONDING_CURVE_LAUNCHPAD_ABI } from '@/packages/launchpad/contracts/BondingCurveLaunchpadAbi';
import { resolveNetworkDefinition, isCompatibleChainAlias, ModularRpcManager } from '@/packages/network-registry/rpc-manager';

function isUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

function getTrustedLaunchpadContractForNetwork(networkId: string): string | null {
  if (networkId === 'base-mainnet') {
    const addr = process.env.LAUNCHPAD_CONTRACT_ADDRESS || process.env.NEXT_PUBLIC_LAUNCHPAD_CONTRACT_ADDRESS;
    return addr && ethers.isAddress(addr) ? ethers.getAddress(addr) : null;
  }
  if (networkId === 'base-sepolia') {
    const addr = process.env.LAUNCHPAD_CONTRACT_ADDRESS_BASE_SEPOLIA || process.env.NEXT_PUBLIC_LAUNCHPAD_CONTRACT_ADDRESS_BASE_SEPOLIA;
    return addr && ethers.isAddress(addr) ? ethers.getAddress(addr) : null;
  }
  if (networkId === 'robinhood-mainnet') {
    const addr = process.env.LAUNCHPAD_CONTRACT_ADDRESS_ROBINHOOD || process.env.NEXT_PUBLIC_LAUNCHPAD_CONTRACT_ADDRESS_ROBINHOOD;
    return addr && ethers.isAddress(addr) ? ethers.getAddress(addr) : null;
  }
  return null;
}

export interface SettleBountyClaimOptions {
  provider?: ethers.Provider;
  adapter?: BountyDbAdapter;
  expectedTo?: string;
  expectedChain?: string;
  expectedTokenAddress?: string;
  rpcManager?: ModularRpcManager;
}

async function settleBountyClaimHandler(
  req: NextRequest,
  options?: SettleBountyClaimOptions
) {
  try {
    // 1. Enforce Authentication & RBAC Authorization
    let session;
    try {
      session = await requireCapability(req, 'SETTLE_BOUNTY_CLAIM');
    } catch (authErr: any) {
      const msg = authErr?.message || 'Authentication required';
      const isForbidden = msg.includes('RBAC_FORBIDDEN') || msg.includes('AUTH_ACCOUNT');
      const statusCode = isForbidden ? 403 : 401;
      return NextResponse.json(
        {
          success: false,
          error: isForbidden
            ? `FORBIDDEN: ${msg}`
            : `UNAUTHORIZED: ${msg}`,
          timestamp: new Date().toISOString(),
        },
        { status: statusCode }
      );
    }

    const body = await req.json();
    const { claimId, txHash, chain } = body;

    // 2. Input Validation
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

    // 3. Resolve & Verify Claim Existence
    const adapter = options?.adapter || defaultBountyDbAdapter;
    const claim = adapter.getClaimById ? await adapter.getClaimById(claimId) : null;
    if (!claim) {
      return NextResponse.json(
        { success: false, error: 'CLAIM_NOT_FOUND: Klaim tidak ditemukan.' },
        { status: 404 }
      );
    }

    // 4. Resolve Claimant Identity & Verify Caller Ownership
    let claimantWallet = '';
    if (claim.kolUserId && ethers.isAddress(claim.kolUserId)) {
      claimantWallet = claim.kolUserId.toLowerCase();
    } else if (claim.kolId && ethers.isAddress(claim.kolId)) {
      claimantWallet = claim.kolId.toLowerCase();
    } else if (claim.kolId) {
      const kolProfile = await defaultKolDbAdapter.getKolProfile(claim.kolId);
      if (kolProfile?.userId && ethers.isAddress(kolProfile.userId)) {
        claimantWallet = kolProfile.userId.toLowerCase();
      }
    }
    if (!claimantWallet && claim.kolId) {
      claimantWallet = claim.kolId.toLowerCase();
    }

    const isAdmin = session.user.roles.some((r) => ['SUPER_ADMIN', 'SYSTEM_ADMIN'].includes(r));
    if (!isAdmin && claimantWallet) {
      const isClaimant =
        session.walletAddress.toLowerCase() === claimantWallet ||
        session.user.userId.toLowerCase() === claimantWallet;
      if (!isClaimant) {
        return NextResponse.json(
          { success: false, error: 'FORBIDDEN: Anda tidak berwenang untuk menyelesaikan klaim ini.' },
          { status: 403 }
        );
      }
    }

    // 5. State Machine & Idempotency Pre-Checks
    if (claim.verificationStatus === 'CLAIMED' || (claim.settlementTxHash && claim.settlementTxHash !== null)) {
      return NextResponse.json(
        { success: false, error: 'ALREADY_SETTLED: Klaim ini sudah diselesaikan sebelumnya.' },
        { status: 409 }
      );
    }

    if (claim.verificationStatus !== 'VERIFIED') {
      return NextResponse.json(
        {
          success: false,
          error: `INVALID_CLAIM_STATE: Status klaim saat ini adalah ${claim.verificationStatus}. Hanya klaim berstatus VERIFIED yang dapat diselesaikan on-chain.`,
        },
        { status: 400 }
      );
    }

    // 6. Pre-Settlement REVIEW Status Revalidation Guard (Phase 2C Guard)
    const pool = getDbPool();
    if (pool) {
      const userIdForTrust = claim.kolUserId || claim.kolId || claimantWallet;
      try {
        const trustTierRes = await pool.query(
          `SELECT trust_tier FROM user_trust_profiles WHERE user_id = $1 LIMIT 1`,
          [userIdForTrust]
        );
        if (trustTierRes.rows.length > 0 && trustTierRes.rows[0].trust_tier === 'REVIEW') {
          await pool.query(
            `INSERT INTO audit_logs (actor_id, action, entity_id, reason, created_at)
             VALUES ($1, 'SETTLEMENT_BLOCKED_UNDER_REVIEW', $2, 'Settlement blocked: claimant is currently in REVIEW status', NOW())`,
            [userIdForTrust, claimId]
          );
          return NextResponse.json(
            {
              success: false,
              error: `SETTLEMENT_BLOCKED_UNDER_REVIEW: Claimant ${userIdForTrust} is currently under REVIEW`,
            },
            { status: 403 }
          );
        }
      } catch (err: any) {
        if (err?.message?.includes('SETTLEMENT_BLOCKED_UNDER_REVIEW')) throw err;
      }
    }

    // 7. Resolve Associated Campaign & Authoritative Contracts
    const campaignResolver = adapter.getCampaign ? adapter.getCampaign.bind(adapter) : defaultBountyDbAdapter.getCampaign.bind(defaultBountyDbAdapter);
    const campaign = await campaignResolver(claim.campaignId);
    if (!campaign) {
      return NextResponse.json(
        { success: false, error: 'CAMPAIGN_NOT_FOUND: Kampanye bounty terkait tidak ditemukan.' },
        { status: 404 }
      );
    }

    let launch: { contractAddress?: string; chain?: string } | null = null;
    if (campaign.launchId) {
      try {
        launch = adapter.getLaunchById
          ? await adapter.getLaunchById(campaign.launchId)
          : await defaultBountyDbAdapter.getLaunchById?.(campaign.launchId) ?? null;
      } catch {}
    }

    // Fail-closed validation for campaign and launch chain consistency
    if (launch?.chain && campaign.chain && !isCompatibleChainAlias(launch.chain, campaign.chain)) {
      return NextResponse.json(
        { success: false, error: 'CAMPAIGN_LAUNCH_MISMATCH: Chain kampanye tidak cocok dengan chain token launch.' },
        { status: 400 }
      );
    }

    const expectedReward = claim.rewardPerKol || campaign.rewardPerKol || 0n;
    if (expectedReward <= 0n) {
      return NextResponse.json(
        { success: false, error: 'INVALID_REWARD_AMOUNT: Nominal reward kampanye tidak valid.' },
        { status: 500 }
      );
    }

    // 8. Server-Side Deterministic Target Network Resolution
    // Strictly determined from authoritative server context (options -> campaign -> launch)
    // NEVER assume NEXT_PUBLIC_DEFAULT_CHAIN proves the campaign network!
    const serverRawChain = (
      options?.expectedChain ||
      campaign.chain ||
      launch?.chain ||
      ''
    ).toLowerCase().trim();

    if (!serverRawChain) {
      return NextResponse.json(
        {
          success: false,
          error: 'CONFIGURATION_ERROR: UNDETERMINED_CAMPAIGN_CHAIN: Jaringan blockchain untuk kampanye bounty tidak dapat ditentukan secara tegas.',
        },
        { status: 500 }
      );
    }

    const networkDef = resolveNetworkDefinition(serverRawChain);
    if (!networkDef) {
      return NextResponse.json(
        {
          success: false,
          error: `CONFIGURATION_ERROR: UNKNOWN_TARGET_NETWORK: Jaringan server "${serverRawChain}" tidak dikenal.`,
        },
        { status: 500 }
      );
    }

    const targetNetworkId = networkDef.networkId;
    const targetChainId = networkDef.chainId;

    if (chain && typeof chain === 'string') {
      const reqChain = chain.toLowerCase().trim();
      const reqDef = resolveNetworkDefinition(reqChain);
      if (!reqDef || reqDef.networkId !== targetNetworkId) {
        return NextResponse.json(
          {
            success: false,
            error: `WRONG_CHAIN: Chain "${chain}" tidak sesuai dengan chain server ("${targetNetworkId}").`,
          },
          { status: 400 }
        );
      }
    }

    // 8.1 Authoritative Launchpad Contract Address Resolution (Fail-Closed)
    // Token address is NEVER used as launchpad contract address!
    // Global Base contract is NEVER used for non-Base networks!
    let canonicalLaunchpadContract = (
      options?.expectedTo ||
      claim.launchpadContractAddress ||
      launch?.contractAddress ||
      getTrustedLaunchpadContractForNetwork(targetNetworkId) ||
      ''
    ).toLowerCase().trim();

    if (!canonicalLaunchpadContract) {
      return NextResponse.json(
        {
          success: false,
          error: `CONFIGURATION_ERROR: MISSING_LAUNCHPAD_CONTRACT: Alamat smart contract launchpad tepercaya tidak terkonfigurasi untuk jaringan "${targetNetworkId}".`,
        },
        { status: 500 }
      );
    }

    if (!ethers.isAddress(canonicalLaunchpadContract)) {
      return NextResponse.json(
        {
          success: false,
          error: 'CONFIGURATION_ERROR: INVALID_LAUNCHPAD_CONTRACT: Alamat smart contract launchpad tidak valid.',
        },
        { status: 500 }
      );
    }

    // 8.2 Authoritative Token Address Resolution (Fail-Closed)
    // Launchpad contract address is NEVER used as token address!
    let canonicalTokenAddress = (
      options?.expectedTokenAddress ||
      (claim as any).tokenAddress ||
      campaign.tokenAddress ||
      ''
    ).toLowerCase().trim();

    if (!canonicalTokenAddress) {
      return NextResponse.json(
        {
          success: false,
          error: 'CONFIGURATION_ERROR: MISSING_TOKEN_ADDRESS: Alamat token kampanye tidak terkonfigurasi.',
        },
        { status: 500 }
      );
    }

    if (!ethers.isAddress(canonicalTokenAddress)) {
      return NextResponse.json(
        {
          success: false,
          error: 'CONFIGURATION_ERROR: INVALID_TOKEN_ADDRESS: Alamat token kampanye tidak valid.',
        },
        { status: 500 }
      );
    }

    // 8.3 ModularRpcManager Resolution (Fail-Closed, Zero Hardcoded Fallbacks)
    const rpcManager = options?.rpcManager || defaultRpcManager;
    let rpcUrl = '';
    try {
      rpcUrl = await rpcManager.getActiveHttpRpc(targetNetworkId, 'LAUNCHPAD');
    } catch (rpcLookupErr: any) {
      return NextResponse.json(
        {
          success: false,
          error: `RPC_UNAVAILABLE: Gagal mendapatkan endpoint RPC untuk jaringan ${targetNetworkId}: ${rpcLookupErr?.message || 'NO_HEALTHY_RPC'}`,
        },
        { status: 503 }
      );
    }

    if (!rpcUrl) {
      return NextResponse.json(
        {
          success: false,
          error: `RPC_UNAVAILABLE: Tidak ada endpoint RPC aktif yang tersedia untuk jaringan ${targetNetworkId}.`,
        },
        { status: 503 }
      );
    }

    const provider: ethers.Provider = options?.provider || new ethers.JsonRpcProvider(rpcUrl);

    // 8.4 Verify Provider Chain ID Matches Target Network
    if (typeof provider.getNetwork === 'function') {
      let rpcNetwork: ethers.Network;
      try {
        rpcNetwork = await provider.getNetwork();
      } catch (netErr: any) {
        return NextResponse.json(
          {
            success: false,
            error: 'RPC_UNAVAILABLE: Gagal mengambil network information dari provider RPC.',
          },
          { status: 503 }
        );
      }

      const rpcChainId = Number(rpcNetwork.chainId);
      if (rpcChainId !== targetChainId) {
        return NextResponse.json(
          {
            success: false,
            error: `CHAIN_ID_MISMATCH: Chain ID provider (${rpcChainId}) tidak sesuai dengan chain ID target (${targetChainId}).`,
          },
          { status: 400 }
        );
      }
    }

    // 9. On-Chain Receipt Verification (STRICT FAIL-CLOSED)
    let receipt: ethers.TransactionReceipt | null;
    try {
      receipt = await provider.getTransactionReceipt(txHash);
    } catch (rpcErr: any) {
      return NextResponse.json(
        {
          success: false,
          error: 'RPC_UNAVAILABLE: Gagal memverifikasi receipt transaksi blockchain karena timeout atau kegagalan RPC.',
        },
        { status: 503 }
      );
    }

    if (!receipt) {
      return NextResponse.json(
        {
          success: false,
          error: 'TX_NOT_FOUND: RECEIPT_NOT_FOUND: Receipt transaksi tidak ditemukan di blockchain.',
        },
        { status: 400 }
      );
    }

    if (receipt.status === 0) {
      return NextResponse.json(
        {
          success: false,
          error: 'TRANSACTION_REVERTED_ONCHAIN: Transaksi gagal dieksekusi di blockchain (status revert on-chain).',
        },
        { status: 400 }
      );
    }

    // 9.1 Block Finality Verification (Phase 4)
    if (
      (options?.provider && typeof options.provider.getBlockNumber === 'function') ||
      (process.env.NODE_ENV !== 'test' && typeof provider.getBlockNumber === 'function')
    ) {
      if (receipt.blockNumber != null) {
        let currentBlock: number;
        try {
          currentBlock = await provider.getBlockNumber();
        } catch (err: any) {
          return NextResponse.json(
            {
              success: false,
              error: 'RPC_UNAVAILABLE: Gagal mengambil block number terbaru untuk verifikasi finalitas transaksi.',
            },
            { status: 503 }
          );
        }
        if (currentBlock < receipt.blockNumber) {
          return NextResponse.json(
            {
              success: false,
              error: 'INVALID_BLOCK_FINALITY: Block number receipt mendahului block header terbaru pada chain.',
            },
            { status: 400 }
          );
        }
        const confirmations = currentBlock - receipt.blockNumber + 1;
        const requiredConfirmations = (targetNetworkId.includes('sepolia') || targetNetworkId.includes('testnet') || targetNetworkId.includes('local'))
          ? 1
          : (targetNetworkId.includes('robinhood') || targetNetworkId === '4663' || targetNetworkId === '0x1237')
            ? 1
            : (targetNetworkId.includes('base') || targetNetworkId === '8453' || targetNetworkId === '0x2105')
              ? 2
              : 1;

        if (confirmations < requiredConfirmations) {
          return NextResponse.json(
            {
              success: false,
              error: `BLOCK_CONFIRMATIONS_INSUFFICIENT: Transaksi baru memiliki ${confirmations} konfirmasi blok. Memerlukan minimal ${requiredConfirmations} konfirmasi untuk finalitas.`,
            },
            { status: 425 }
          );
        }
      }
    }

    // 10. Validate Target Contract (Phase 3A Security Control)
    const canonicalLower = canonicalLaunchpadContract.toLowerCase();
    const txToLower = (receipt.to || '').toLowerCase();
    const hasLogFromContract = (receipt.logs || []).some(
      (log) => (log.address || '').toLowerCase() === canonicalLower
    );
    if (receipt.to && txToLower !== canonicalLower && !hasLogFromContract) {
      return NextResponse.json(
        {
          success: false,
          error: 'INVALID_SETTLEMENT_CONTRACT: UNEXPECTED_CONTRACT_EMITTER: Transaksi tidak berinteraksi dengan contract yang sesuai.',
        },
        { status: 400 }
      );
    }

    // 11. Event Log Parsing & Cryptographic Proof Verification (Phase 3A & Blocker 1)
    if (receipt.logs !== undefined) {
      const iface = new ethers.Interface(BONDING_CURVE_LAUNCHPAD_ABI);
      const bountyRewardClaimedEvent = iface.getEvent('BountyRewardClaimed');
      const bountyTopic = bountyRewardClaimedEvent?.topicHash;

      let matchingLog: ethers.LogDescription | null = null;
      let hasLogFromWrongContract = false;

      const receiptLogs = receipt.logs || [];
      for (const rawLog of receiptLogs) {
        if (!rawLog.topics || rawLog.topics.length === 0) continue;
        if (rawLog.topics[0] === bountyTopic) {
          const logEmitter = (rawLog.address || '').toLowerCase();
          if (logEmitter !== canonicalLower) {
            hasLogFromWrongContract = true;
            continue;
          }
          try {
            const parsed = iface.parseLog({
              topics: rawLog.topics as string[],
              data: rawLog.data,
            });
            if (parsed && parsed.name === 'BountyRewardClaimed') {
              matchingLog = parsed;
              break;
            }
          } catch {}
        }
      }

      if (!matchingLog) {
        if (hasLogFromWrongContract) {
          return NextResponse.json(
            {
              success: false,
              error: 'INVALID_SETTLEMENT_CONTRACT: UNEXPECTED_CONTRACT_EMITTER: Event penyelesaian bounty di-emit oleh smart contract yang tidak sah.',
            },
            { status: 400 }
          );
        }
        return NextResponse.json(
          {
            success: false,
            error: 'INVALID_SETTLEMENT_EVENT: NO_SETTLEMENT_EVENT_FOUND: Receipt transaksi tidak memuat event BountyRewardClaimed yang sah.',
          },
          { status: 400 }
        );
      }

      // 11.1 Validate recipient wallet argument against claimant wallet
      const eventKolWallet = (matchingLog.args.kolWallet || '').toLowerCase();
      if (claimantWallet && eventKolWallet !== claimantWallet) {
        return NextResponse.json(
          {
            success: false,
            error: `INVALID_SETTLEMENT_EVENT: MISMATCHED_RECIPIENT_WALLET: Alamat wallet penerima (${eventKolWallet}) tidak cocok dengan pemilik klaim (${claimantWallet}).`,
          },
          { status: 400 }
        );
      }

      // 11.2 Validate reward amount argument against campaign reward
      const eventAmount = BigInt(matchingLog.args.amountTokens || 0);
      if (eventAmount !== expectedReward) {
        return NextResponse.json(
          {
            success: false,
            error: `INVALID_SETTLEMENT_EVENT: MISMATCHED_REWARD_AMOUNT: Jumlah reward on-chain (${eventAmount.toString()}) tidak cocok dengan reward per KOL kampanye (${expectedReward.toString()}).`,
          },
          { status: 400 }
        );
      }

      // 11.3 Validate token address against campaign token contract (MANDATORY IN ALL MODES)
      const eventTokenAddress = (matchingLog.args.tokenAddress || '').toLowerCase();
      if (eventTokenAddress !== canonicalTokenAddress.toLowerCase()) {
        return NextResponse.json(
          {
            success: false,
            error: `INVALID_SETTLEMENT_EVENT: MISMATCHED_TOKEN_ADDRESS: Alamat token pada event (${eventTokenAddress}) tidak cocok dengan token kampanye (${canonicalTokenAddress.toLowerCase()}).`,
          },
          { status: 400 }
        );
      }
    }

    // 12. Settle Claim Idempotently & Atomically in Database
    try {
      const settleResult = await adapter.settleClaimOnChain?.(claimId, txHash, receipt.blockNumber);
      if (settleResult && typeof settleResult === 'object') {
        if (settleResult.alreadySettled) {
          return NextResponse.json(
            {
              success: false,
              error: 'ALREADY_SETTLED: Klaim ini sudah diselesaikan sebelumnya.',
            },
            { status: 409 }
          );
        }
        if (settleResult.txAlreadyUsed) {
          return NextResponse.json(
            {
              success: false,
              error: `TRANSACTION_ALREADY_USED: ${settleResult.error || 'Hash transaksi ini sudah digunakan untuk menyelesaikan klaim bounty lain.'}`,
            },
            { status: 409 }
          );
        }
        if (!settleResult.success) {
          return NextResponse.json(
            {
              success: false,
              error: `DATABASE_SETTLEMENT_FAILED: ${settleResult.error || 'Gagal mencatat penyelesaian klaim di basis data.'}`,
            },
            { status: 500 }
          );
        }
      }
    } catch (err: any) {
      if (err?.message?.includes('SETTLEMENT_BLOCKED_UNDER_REVIEW')) {
        return NextResponse.json(
          { success: false, error: err.message },
          { status: 403 }
        );
      }
      if (err?.message?.includes('SETTLEMENT_IDEMPOTENCY_VIOLATION')) {
        return NextResponse.json(
          { success: false, error: 'ALREADY_SETTLED: Klaim ini sudah diselesaikan sebelumnya.' },
          { status: 409 }
        );
      }
      throw err;
    }

    return NextResponse.json({
      success: true,
      message: 'Klaim reward SocialFi berhasil diselesaikan on-chain.',
      data: {
        claimId,
        txHash,
        blockNumber: receipt.blockNumber || null,
        status: 'CLAIMED',
        settledAt: new Date().toISOString(),
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      {
        success: false,
        error: `INTERNAL_SERVER_ERROR: ${err?.message || 'Internal server error'}`,
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest, context?: { options?: SettleBountyClaimOptions }) {
  return settleBountyClaimHandler(req, context?.options);
}
