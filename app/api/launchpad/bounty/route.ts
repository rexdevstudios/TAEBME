import { NextRequest, NextResponse } from 'next/server';
import { ApiResponse } from '@packages/shared/contracts/api-contracts';
import { BountyCampaign } from '@packages/shared/types/domain';
import { isValidCampaignTrustTier, CampaignTrustTier } from '@packages/shared/types/trust';
import { defaultBountyDbAdapter } from '@packages/shared/db-pool';
import { notifyPublicTelegramChannelBestEffort } from '@packages/notifications/webhook-dispatcher';
import {
  encodeRequiredFollowInDescription,
  normalizeFollowHandle,
  parseRequiredFollowFromDescription,
} from '@packages/shared/airdrop-referral';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const launchId = searchParams.get('launchId') || undefined;

  const campaigns = await defaultBountyDbAdapter.listCampaigns(launchId);
  const serialized = campaigns.map((c) => ({
    ...c,
    rewardPerKol: c.rewardPerKol.toString(),
    requiredFollowHandle: parseRequiredFollowFromDescription((c as any).description),
  }));

  const response: ApiResponse<typeof serialized> = {
    success: true,
    data: serialized,
    timestamp: new Date().toISOString(),
  };
  return NextResponse.json(response);
}

import { requireCapability } from '@packages/auth/session';

export async function POST(req: NextRequest) {
  try {
    // SG-03: Require authenticated session with campaign creation capability
    const session = await requireCapability(req, 'PUBLISH_LAUNCH');

    const body = await req.json().catch(() => ({}));
    const {
      launchId,
      creatorId,
      title,
      requiredHashtag,
      minFollowers,
      rewardPerKol,
      maxParticipants,
      minTrustTier,
    } = body;

    // Reject caller attempting to impersonate another creator
    if (creatorId && creatorId !== session.user.userId) {
      const res: ApiResponse<null> = {
        success: false,
        error: { code: 'FORBIDDEN', message: 'Cannot create a campaign on behalf of another creator' },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(res, { status: 403 });
    }

    if (!title || !requiredHashtag) {
      const res: ApiResponse<null> = {
        success: false,
        error: { code: 'INVALID_INPUT', message: 'title and requiredHashtag are required' },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(res, { status: 400 });
    }

    // Phase 2C: Validate optional minTrustTier (default 'NEW', reject 'REVIEW' and unknown strings)
    let validatedMinTrustTier: CampaignTrustTier = 'NEW';
    if (minTrustTier !== undefined && minTrustTier !== null) {
      if (!isValidCampaignTrustTier(minTrustTier)) {
        const res: ApiResponse<null> = {
          success: false,
          error: {
            code: 'INVALID_INPUT',
            message: `Invalid minTrustTier: ${minTrustTier}. Allowed values: NEW, VERIFIED, ESTABLISHED, TRUSTED`,
          },
          timestamp: new Date().toISOString(),
        };
        return NextResponse.json(res, { status: 400 });
      }
      validatedMinTrustTier = minTrustTier;
    }

    const requiredFollowHandle = normalizeFollowHandle(body?.requiredFollowHandle);
    const encodedDescription = encodeRequiredFollowInDescription(
      typeof body?.description === 'string' ? body.description : '',
      requiredFollowHandle
    );

    const newCampaign: BountyCampaign & { description?: string } = {
      id: `campaign-${Date.now()}`,
      launchId: launchId || `launch-${Date.now()}`,
      creatorId: session.user.userId,
      title,
      description: encodedDescription,
      campaignType: 'BOUNTY',
      minTrustTier: validatedMinTrustTier,
      requiredHashtag: requiredHashtag.startsWith('#') ? requiredHashtag : `#${requiredHashtag}`,
      minFollowers: Number(minFollowers) || 500,
      rewardPerKol: BigInt(rewardPerKol || '1000000000000000000000'),
      maxParticipants: Number(maxParticipants) || 50,
      currentParticipants: 0,
      isActive: true,
    };

    const savedId = await defaultBountyDbAdapter.createCampaign(newCampaign);
    newCampaign.id = savedId;

    await notifyPublicTelegramChannelBestEffort({
      event: 'AIRDROP_CAMPAIGN_CREATED',
      title: `New Airdrop / KOL Bounty: ${newCampaign.title}`,
      message: `Hashtag: ${newCampaign.requiredHashtag}${requiredFollowHandle ? ` · Follow: ${requiredFollowHandle}` : ''} · Slots: ${newCampaign.maxParticipants}\nJoin & Claim (SIWE + GoPlus Verified): https://pndigi.site/kol?campaignId=${encodeURIComponent(savedId)}&tab=CLAIM`,
      metadata: {
        campaignId: savedId,
        maxParticipants: newCampaign.maxParticipants,
        hashtag: newCampaign.requiredHashtag,
        ...(requiredFollowHandle ? { requiredFollowHandle } : {}),
      },
      buttons: [
        {
          text: 'Claim Airdrop →',
          url: `https://pndigi.site/kol?campaignId=${encodeURIComponent(savedId)}&tab=CLAIM`,
        },
        {
          text: 'All Airdrops',
          url: 'https://pndigi.site/kol',
        },
      ],
    });

    const serialized = {
      ...newCampaign,
      rewardPerKol: newCampaign.rewardPerKol.toString(),
      requiredFollowHandle,
    };

    const response: ApiResponse<typeof serialized> = {
      success: true,
      data: serialized,
      timestamp: new Date().toISOString(),
    };
    return NextResponse.json(response, { status: 201 });
  } catch (error: any) {
    const message = error?.message || 'Failed to create bounty campaign';
    if (message.startsWith('UNAUTHORIZED')) {
      return NextResponse.json(
        { success: false, error: { code: 'UNAUTHORIZED', message }, timestamp: new Date().toISOString() },
        { status: 401 }
      );
    }
    if (message.startsWith('RBAC_FORBIDDEN') || message.startsWith('AUTH_ACCOUNT_')) {
      return NextResponse.json(
        { success: false, error: { code: 'FORBIDDEN', message }, timestamp: new Date().toISOString() },
        { status: 403 }
      );
    }
    const res: ApiResponse<null> = {
      success: false,
      error: { code: 'CAMPAIGN_CREATION_FAILED', message },
      timestamp: new Date().toISOString(),
    };
    return NextResponse.json(res, { status: 400 });
  }
}
