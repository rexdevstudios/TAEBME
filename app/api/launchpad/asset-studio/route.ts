/**
 * app/api/launchpad/asset-studio/route.ts
 *
 * Stateless Vercel Control Plane endpoint for Creator Asset Studio
 * (AI Token Identity, Pollinations Logo Generation, Pinata IPFS Upload).
 *
 * - RBAC: requires CREATE_LAUNCH_DRAFT capability (CREATOR, LAUNCH_ADMIN, SYSTEM_ADMIN, SUPER_ADMIN).
 * - Zero private keys, zero disk I/O, zero src/ imports (AGENTS.md Rules 1 & 3).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCapability } from '@packages/auth/session';
import { SubscriptionsEngine } from '@packages/billing/subscriptions-engine';
import { defaultBillingDbAdapter, getDbPool } from '@packages/shared/db-pool';
import {
  generateTokenIdentityFromTrend,
  generateTokenLogoBuffer,
  uploadLogoAndMetadataToIpfs,
  TokenIdentitySchema,
  sanitizeIdentityRaw,
  applyIdentityPrivacyShield,
} from '@packages/launchpad/creator-asset-studio';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    let auth;
    try {
      auth = await requireCapability(req, 'CREATE_LAUNCH_DRAFT');
    } catch (authErr: unknown) {
      const msg = authErr instanceof Error ? authErr.message : String(authErr);
      const isForbidden = msg.includes('RBAC_FORBIDDEN') || msg.includes('AUTH_ACCOUNT');
      return NextResponse.json(
        { success: false, error: isForbidden ? `FORBIDDEN: ${msg}` : `UNAUTHORIZED: ${msg}`, timestamp: new Date().toISOString() },
        { status: isForbidden ? 403 : 401 }
      );
    }

    const burnStudioCredit = async (actionName: string): Promise<number | undefined> => {
      try {
        if (getDbPool() && auth?.walletAddress) {
          await SubscriptionsEngine.deductMeteredCredits(
            auth.walletAddress,
            1,
            'AI_ASSET_STUDIO',
            `studio-${actionName}-${Date.now()}`,
            defaultBillingDbAdapter
          );
          return await defaultBillingDbAdapter.getUserCreditBalance(auth.walletAddress);
        }
      } catch {
        // Non-blocking fallback
      }
      return undefined;
    };

    const body = await req.json().catch(() => ({}));
    const action = typeof body?.action === 'string' ? body.action : '';

    if (action === 'generate-identity') {
      const trendPrompt = typeof body?.trendPrompt === 'string' ? body.trendPrompt.trim() : '';
      if (trendPrompt.length < 3 || trendPrompt.length > 3000) {
        return NextResponse.json(
          { success: false, error: 'INVALID_INPUT: trendPrompt must be 3-3000 characters', timestamp: new Date().toISOString() },
          { status: 400 }
        );
      }

      const result = await generateTokenIdentityFromTrend(trendPrompt);
      const remainingCredits = await burnStudioCredit('generate-identity');
      return NextResponse.json({
        success: true,
        data: { ...result, creditsBurned: 1, remainingCredits },
        timestamp: new Date().toISOString(),
      });
    }

    if (action === 'generate-logo') {
      const imagePrompt = typeof body?.imagePrompt === 'string' ? body.imagePrompt.trim() : '';
      const tokenName = typeof body?.tokenName === 'string' ? body.tokenName.trim() : 'Token';
      if (imagePrompt.length < 3) {
        return NextResponse.json(
          { success: false, error: 'INVALID_INPUT: imagePrompt is required', timestamp: new Date().toISOString() },
          { status: 400 }
        );
      }

      const { buffer, isFallback, provider } = await generateTokenLogoBuffer(imagePrompt, tokenName);
      const imageDataUri = `data:image/png;base64,${buffer.toString('base64')}`;

      if (body?.uploadToIpfs && body?.identity) {
        const sanitized = sanitizeIdentityRaw(body.identity);
        const parsed = TokenIdentitySchema.safeParse(sanitized);
        if (!parsed.success) {
          return NextResponse.json(
            { success: false, error: 'INVALID_IDENTITY: Cannot upload metadata with invalid identity fields', timestamp: new Date().toISOString() },
            { status: 400 }
          );
        }
        const safeIdentity = applyIdentityPrivacyShield(parsed.data);
        const ipfs = await uploadLogoAndMetadataToIpfs(buffer, safeIdentity);
        const remainingCredits = await burnStudioCredit('generate-logo-ipfs');
        return NextResponse.json({
          success: true,
          data: {
            imageDataUri,
            byteLength: buffer.length,
            isFallback,
            provider,
            ipfsImageUrl: ipfs.imageUrl,
            ipfsMetadataUrl: ipfs.metadataUrl,
            uploadedToIpfs: ipfs.uploadedToIpfs,
            creditsBurned: 1,
            remainingCredits,
          },
          timestamp: new Date().toISOString(),
        });
      }

      const remainingCredits = await burnStudioCredit('generate-logo');
      return NextResponse.json({
        success: true,
        data: {
          imageDataUri,
          byteLength: buffer.length,
          isFallback,
          provider,
          uploadedToIpfs: false,
          creditsBurned: 1,
          remainingCredits,
        },
        timestamp: new Date().toISOString(),
      });
    }

    return NextResponse.json(
      { success: false, error: 'INVALID_ACTION: Supported actions are generate-identity and generate-logo', timestamp: new Date().toISOString() },
      { status: 400 }
    );
  } catch (err: unknown) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'ASSET_STUDIO_ERROR', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}
