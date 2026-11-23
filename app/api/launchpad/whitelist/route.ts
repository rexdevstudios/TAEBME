import { NextRequest, NextResponse } from 'next/server';
import { ApiResponse } from '@packages/shared/contracts/api-contracts';
import { LaunchDraftService } from '@packages/launchpad/launch-draft-service';
import { getDbPool } from '@packages/shared/db-pool';
import { ethers } from 'ethers';

const ZERO_ROOT = '0x0000000000000000000000000000000000000000000000000000000000000000';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const tokenAddress = searchParams.get('tokenAddress') || '';
  const walletAddress = searchParams.get('walletAddress') || '';
  const rawWhitelist = searchParams.get('whitelist') || '';

  if (!walletAddress || !ethers.isAddress(walletAddress)) {
    const res: ApiResponse<null> = {
      success: false,
      error: { code: 'MISSING_WALLET', message: 'Valid walletAddress query parameter is required' },
      timestamp: new Date().toISOString(),
    };
    return NextResponse.json(res, { status: 400 });
  }

  let wallets: string[] = [];

  if (rawWhitelist) {
    wallets = rawWhitelist.split(',').map((w) => w.trim()).filter((w) => ethers.isAddress(w));
  } else if (tokenAddress && ethers.isAddress(tokenAddress)) {
    // Authoritative lookup from PostgreSQL SSOT (fail-closed: never self-echo caller wallet)
    const pool = getDbPool();
    if (pool) {
      try {
        // Unified read: combine relational launch_whitelists rows + legacy launch_drafts.social_links JSONB (Phase CC2)
        const [jsonRes, relRes] = await Promise.all([
          pool.query(
            `SELECT ld.social_links->>'whitelist_wallets' AS whitelist_wallets
             FROM token_launches tl
             JOIN launch_drafts ld ON ld.id = tl.draft_id
             WHERE LOWER(tl.contract_address) = LOWER($1)
             LIMIT 1`,
            [tokenAddress]
          ),
          pool
            .query(
              `SELECT lw.wallet_address
               FROM launch_whitelists lw
               JOIN token_launches tl ON tl.draft_id = lw.draft_id
               WHERE LOWER(tl.contract_address) = LOWER($1)`,
              [tokenAddress]
            )
            .catch(() => ({ rows: [] })),
        ]);

        const combined = new Set<string>();
        const storedRaw = jsonRes.rows[0]?.whitelist_wallets;
        if (typeof storedRaw === 'string' && storedRaw.trim().length > 0) {
          for (const w of storedRaw.split(',').map((item: string) => item.trim())) {
            if (ethers.isAddress(w)) combined.add(ethers.getAddress(w));
          }
        }
        for (const row of relRes.rows || []) {
          const w = String((row as any)?.wallet_address || '').trim();
          if (ethers.isAddress(w)) combined.add(ethers.getAddress(w));
        }
        wallets = Array.from(combined);
      } catch {
        // Fail closed — treat as empty whitelist
      }
    }
  }

  // Fail-closed: if no whitelist entries exist, caller is NOT whitelisted
  const normalizedTarget = ethers.getAddress(walletAddress).toLowerCase();
  const isWhitelisted = wallets.some((w) => ethers.getAddress(w).toLowerCase() === normalizedTarget);
  const tree = wallets.length > 0 ? LaunchDraftService.generateMerkleTree(wallets) : { root: ZERO_ROOT, getProof: () => [] };
  const proof = isWhitelisted ? tree.getProof(walletAddress) : [];

  const response: ApiResponse<{
    tokenAddress: string;
    walletAddress: string;
    isWhitelisted: boolean;
    merkleRoot: string;
    merkleProof: string[];
  }> = {
    success: true,
    data: {
      tokenAddress,
      walletAddress: ethers.getAddress(walletAddress),
      isWhitelisted,
      merkleRoot: tree.root,
      merkleProof: proof,
    },
    timestamp: new Date().toISOString(),
  };

  return NextResponse.json(response);
}
