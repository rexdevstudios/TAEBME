import { NextRequest, NextResponse } from 'next/server';
import { SybilResistanceService } from '@/packages/social/sybil-resistance-service';
import { getTrustEvidenceService } from '@/packages/shared/db-pool';
import { authenticateSession } from '@/packages/auth/session';
import { ethers } from 'ethers';

export async function POST(req: NextRequest) {
  try {
    // 1. Enforce SIWE Session Authentication (Fail-Closed)
    const session = await authenticateSession(req);
    if (!session) {
      return NextResponse.json(
        { success: false, error: 'UNAUTHORIZED: Valid cryptographic SIWE session token required for sybil verification' },
        { status: 401 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const { mode, walletAddress, minScore, worldIdPayload, campaignId } = body;

    // 2. Validate wallet address binding to authenticated session
    const targetWallet = session.walletAddress;
    if (walletAddress && walletAddress.toLowerCase() !== targetWallet.toLowerCase()) {
      return NextResponse.json(
        { success: false, error: 'FORBIDDEN: Cannot verify sybil credentials for another wallet address' },
        { status: 403 }
      );
    }

    if (mode === 'WORLD_ID') {
      if (!worldIdPayload || !campaignId) {
        return NextResponse.json(
          { success: false, error: 'MISSING_FIELDS: worldIdPayload and campaignId are required for World ID verification' },
          { status: 400 }
        );
      }

      // Phase 1 & Phase 3B: Use DB-persisted anti-replay and cryptographic proof verification
      const trustService = getTrustEvidenceService();
      if (!trustService) {
        // Dev/test fallback when DATABASE_URL is absent
        const result = SybilResistanceService.verifyWorldIdProof(worldIdPayload, campaignId);
        return NextResponse.json({ success: result.isValid, data: result });
      }

      const result = await SybilResistanceService.verifyWorldIdProofPersisted(
        worldIdPayload,
        campaignId,
        trustService,
        undefined,
        session.user.userId
      );

      if (!result.isValid) {
        const statusCode = result.reason?.startsWith('INVALID_ZK_PROOF') ? 422 : 400;
        return NextResponse.json(
          { success: false, error: result.reason, data: result },
          { status: statusCode }
        );
      }

      return NextResponse.json({
        success: true,
        data: result,
      });
    } else {
      // Default Gitcoin Passport verification
      const threshold = Math.max(
        SybilResistanceService.DEFAULT_GITCOIN_THRESHOLD,
        typeof minScore === 'number' ? minScore : SybilResistanceService.DEFAULT_GITCOIN_THRESHOLD
      );

      // Verify via real Gitcoin Scorer API
      let result;
      try {
        result = await SybilResistanceService.verifyGitcoinPassportLive(targetWallet, threshold);
      } catch (scorerErr: any) {
        const msg = scorerErr?.message || 'Gitcoin scorer verification failed';
        const isConfigErr = msg.includes('UNCONFIGURED') || msg.includes('TIMEOUT') || msg.includes('API_ERROR');
        return NextResponse.json(
          { success: false, error: msg },
          { status: isConfigErr ? 503 : 500 }
        );
      }

      // If humanity score satisfies threshold, record GITCOIN_PASSPORT evidence
      if (result.passedThreshold) {
        const trustService = getTrustEvidenceService();
        if (trustService) {
          try {
            await trustService.recordEvidence({
              subjectUserId: session.user.userId,
              evidenceType: 'GITCOIN_PASSPORT',
              sourceType: 'GITCOIN',
              sourceId: targetWallet.toLowerCase(),
              direction: 'POSITIVE',
              metadata: {
                score: result.humanityScore,
                threshold,
                verifiedAt: new Date().toISOString(),
              },
            });
          } catch (evidenceErr: any) {
            console.warn(`[SybilVerify] Failed to record Gitcoin trust evidence:`, evidenceErr?.message);
          }
        }
      }

      return NextResponse.json({
        success: result.passedThreshold,
        data: result,
      });
    }
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || 'SYBIL_VERIFICATION_FAILED' },
      { status: 500 }
    );
  }
}
