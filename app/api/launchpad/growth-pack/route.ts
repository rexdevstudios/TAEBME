/**
 * app/api/launchpad/growth-pack/route.ts
 *
 * Stateless Vercel Control Plane endpoint for Growth Launch Pack
 * (1200x630 OpenGraph SVG Card, DexScreener Profile Payload, GeckoTerminal Profile Payload).
 *
 * - RBAC: requires CREATE_LAUNCH_DRAFT capability.
 * - Zero private keys, zero disk I/O, zero src/ imports (AGENTS.md Rules 1 & 3).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCapability } from '@packages/auth/session';
import { buildGrowthLaunchPack } from '@packages/launchpad/growth-launch-pack';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    try {
      await requireCapability(req, 'CREATE_LAUNCH_DRAFT');
    } catch (authErr: unknown) {
      const msg = authErr instanceof Error ? authErr.message : String(authErr);
      const isForbidden = msg.includes('RBAC_FORBIDDEN') || msg.includes('AUTH_ACCOUNT');
      return NextResponse.json(
        { success: false, error: isForbidden ? `FORBIDDEN: ${msg}` : `UNAUTHORIZED: ${msg}`, timestamp: new Date().toISOString() },
        { status: isForbidden ? 403 : 401 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const tokenName = typeof body?.tokenName === 'string' ? body.tokenName.trim() : '';
    const tokenSymbol = typeof body?.tokenSymbol === 'string' ? body.tokenSymbol.trim() : '';
    const tokenAddress = typeof body?.tokenAddress === 'string' ? body.tokenAddress.trim() : '';
    const chainId = body?.chainId ?? 'base';

    if (!tokenName || !tokenSymbol || !tokenAddress) {
      return NextResponse.json(
        { success: false, error: 'INVALID_INPUT: tokenName, tokenSymbol, and tokenAddress are required', timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }

    const pack = buildGrowthLaunchPack({
      chainId,
      tokenAddress,
      tokenName,
      tokenSymbol,
      poolAddress: typeof body?.poolAddress === 'string' ? body.poolAddress.trim() : undefined,
      description: typeof body?.description === 'string' ? body.description.trim() : undefined,
      iconUrl: typeof body?.iconUrl === 'string' ? body.iconUrl.trim() : undefined,
      headerUrl: typeof body?.headerUrl === 'string' ? body.headerUrl.trim() : undefined,
      websiteUrl: typeof body?.websiteUrl === 'string' ? body.websiteUrl.trim() : undefined,
      twitterUrl: typeof body?.twitterUrl === 'string' ? body.twitterUrl.trim() : undefined,
      telegramUrl: typeof body?.telegramUrl === 'string' ? body.telegramUrl.trim() : undefined,
      discordUrl: typeof body?.discordUrl === 'string' ? body.discordUrl.trim() : undefined,
      safetyScore: typeof body?.safetyScore === 'number' ? body.safetyScore : undefined,
    });

    return NextResponse.json({
      success: true,
      data: pack,
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'GROWTH_PACK_ERROR', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}
