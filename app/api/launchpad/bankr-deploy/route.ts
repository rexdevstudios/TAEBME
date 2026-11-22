/**
 * app/api/launchpad/bankr-deploy/route.ts
 *
 * Vercel-Native Stateless Bankr Gas-Sponsored Token Deployment Endpoint.
 * - Protected by Edge Middleware SIWE + RBAC PUBLISH_LAUNCH + rateLimiter.
 * - Zero private keys in Vercel (uses BANKR_API_KEY REST header only).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCapability } from '@packages/auth/session';
import { rateLimiter } from '@packages/auth/rate-limiter';
import { deployTokenViaBankrApi, type BankrSupportedChain } from '@packages/launchpad/bankr-client';
import {
  SubscriptionsEngine,
  annotateKeysWithQuotaStatus,
  computeEffectiveVaultCapacity,
} from '@packages/billing/subscriptions-engine';
import {
  defaultBillingDbAdapter,
  defaultDraftDbAdapter,
  defaultProviderKeyVaultAdapter,
  getDbPool,
} from '@packages/shared/db-pool';
import { validateMultiChainFeeRecipient } from '@packages/shared/credential-vault';
import { notifyUserWebhookBestEffort } from '@packages/notifications/webhook-dispatcher';
import { resolveBankrEffectiveFeeRecipient } from '@packages/trading/fee-monetization';

export const dynamic = 'force-dynamic';

const VALID_CHAINS = new Set<BankrSupportedChain>(['base', 'robinhood', 'arbitrum', 'arc']);

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for') || '127.0.0.1';
    const rateCheck = await rateLimiter.checkRateLimit(`ratelimit:bankr:deploy:${ip}`, 10, 60);
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { success: false, error: 'TOO_MANY_REQUESTS: Bankr deploy rate limit exceeded', timestamp: new Date().toISOString() },
        { status: 429 }
      );
    }

    let auth;
    try {
      auth = await requireCapability(req, 'PUBLISH_LAUNCH');
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
    const chain = (typeof body?.chain === 'string' ? body.chain.trim().toLowerCase() : 'base') as BankrSupportedChain;
    const providerKeyId =
      typeof body?.providerKeyId === 'string' && body.providerKeyId.trim() !== 'PLATFORM_DEFAULT'
        ? body.providerKeyId.trim()
        : undefined;
    const draftId = typeof body?.draftId === 'string' ? body.draftId.trim() : undefined;

    if (tokenName.length < 2 || tokenSymbol.length < 2) {
      return NextResponse.json(
        { success: false, error: 'INVALID_INPUT: tokenName and tokenSymbol (min 2 chars) are required', timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }
    if (!VALID_CHAINS.has(chain)) {
      return NextResponse.json(
        { success: false, error: 'INVALID_CHAIN: Supported chains are base, robinhood, arbitrum, arc', timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }

    // 1. Validate Multi-Chain Fee Recipient compatibility before touching external API
    try {
      validateMultiChainFeeRecipient(chain, body?.feeRecipient);
    } catch (feeErr: unknown) {
      return NextResponse.json(
        { success: false, error: feeErr instanceof Error ? feeErr.message : 'INVALID_FEE_RECIPIENT', timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }

    // 2. Resolve BYOK API Key from encrypted vault (enforces ownership + chain_scope)
    let resolvedByok: { apiKey: string; keyId: string; label: string; maskedKey: string } | null = null;
    try {
      if (providerKeyId) {
        const [allUserKeys, userPlan, addonSlots] = await Promise.all([
          defaultProviderKeyVaultAdapter.listKeys(auth.walletAddress, 'BANKR'),
          defaultBillingDbAdapter.getUserPlan(auth.walletAddress).catch(() => 'FREE' as const),
          defaultBillingDbAdapter.getUserAddonSlots(auth.walletAddress).catch(() => ({ bankrExtraSlots: 0, binanceExtraSlots: 0 })),
        ]);
        const effCap = computeEffectiveVaultCapacity(userPlan, addonSlots);
        const annotated = annotateKeysWithQuotaStatus(allUserKeys, { maxActive: effCap.maxBankrKeys });
        const targetMeta = annotated.find((k) => k.id === providerKeyId);
        if (targetMeta && targetMeta.quotaStatus !== 'ACTIVE') {
          return NextResponse.json(
            {
              success: false,
              error: `KEY_FROZEN_OVER_QUOTA: API Key "${targetMeta.label}" terkunci karena kuota aktif paket ${effCap.planId} adalah ${effCap.maxBankrKeys} key. Jadikan Default atau perpanjang/beli slot di /billing.`,
              timestamp: new Date().toISOString(),
            },
            { status: 403 }
          );
        }

        resolvedByok = await defaultProviderKeyVaultAdapter.resolveDecryptedKeyForDeploy({
          userIdentifier: auth.walletAddress,
          targetChain: chain,
          keyId: providerKeyId,
          provider: 'BANKR',
        });
      } else if (body?.providerKeyId !== 'PLATFORM_DEFAULT') {
        // Optional auto-resolve default BYOK key if scope matches targetChain
        try {
          resolvedByok = await defaultProviderKeyVaultAdapter.resolveDecryptedKeyForDeploy({
            userIdentifier: auth.walletAddress,
            targetChain: chain,
            provider: 'BANKR',
          });
        } catch {
          resolvedByok = null;
        }
      }
    } catch (vaultErr: unknown) {
      const vMsg = vaultErr instanceof Error ? vaultErr.message : 'BYOK_KEY_ERROR';
      const status = vMsg.startsWith('CHAIN_SCOPE_MISMATCH') ? 400 : 403;
      return NextResponse.json(
        { success: false, error: vMsg, timestamp: new Date().toISOString() },
        { status }
      );
    }

    const platformCfg = await defaultBillingDbAdapter.getPlatformFeeAndRiskConfig().catch(() => null);
    const effectiveFeeRecipient = resolveBankrEffectiveFeeRecipient({
      requestedFeeRecipient: body?.feeRecipient,
      usingPlatformDefaultKey: !resolvedByok,
      treasuryWallet: platformCfg?.treasuryWallet,
    });

    const result = await deployTokenViaBankrApi({
      tokenName,
      tokenSymbol,
      description: typeof body?.description === 'string' ? body.description : undefined,
      image: typeof body?.image === 'string' ? body.image : undefined,
      websiteUrl: typeof body?.websiteUrl === 'string' ? body.websiteUrl : undefined,
      tweetUrl: typeof body?.tweetUrl === 'string' ? body.tweetUrl : undefined,
      chain,
      feeRecipient: effectiveFeeRecipient as any,
      degenMode: body?.degenMode !== false,
      simulateOnly: Boolean(body?.simulateOnly),
      apiKeyOverride: resolvedByok?.apiKey,
    });

    const httpStatus =
      result.status === 'deployed' || result.status === 'simulated'
        ? 200
        : result.status === 'unknown'
        ? 504
        : 422;

    const isSuccess = result.status === 'deployed' || result.status === 'simulated';
    let remainingCredits: number | undefined;
    let persistedLaunchId: string | undefined;
    const launchCostCr = Math.max(0, Number(platformCfg?.launchCostCr ?? 50));

    if (isSuccess) {
      // Auto-sync live Bankr deployed token to PostgreSQL SSOT `token_launches`
      if (result.status === 'deployed' && result.tokenAddress && draftId) {
        try {
          const pub = await defaultDraftDbAdapter.publishLaunchDraft({
            draftId,
            contractAddress: result.tokenAddress,
            chain: `${chain}-mainnet`,
            txHash: result.txHash,
            graduationThreshold: body?.degenMode !== false ? 2500 : 69000,
          });
          persistedLaunchId = pub.launchId;
        } catch {
          // Non-blocking persistence fallback
        }
      }

      try {
        if (getDbPool() && auth?.walletAddress && launchCostCr > 0) {
          await SubscriptionsEngine.deductMeteredCredits(
            auth.walletAddress,
            launchCostCr,
            'TOKEN_LAUNCH_BANKR',
            result.txHash || result.tokenAddress || `bankr-${tokenSymbol}-${Date.now()}`,
            defaultBillingDbAdapter
          );
          remainingCredits = await defaultBillingDbAdapter.getUserCreditBalance(auth.walletAddress);
        }
      } catch {
        // Non-blocking fallback
      }

      if (auth?.walletAddress) {
        await notifyUserWebhookBestEffort({
          resolveWebhookUrl: async () => {
            const hook = await defaultProviderKeyVaultAdapter
              .resolveDecryptedKeyForDeploy({
                userIdentifier: auth.walletAddress,
                targetChain: 'all',
                provider: 'WEBHOOK',
              })
              .catch(() => null);
            return hook?.apiKey || null;
          },
          payload: {
            event: 'TOKEN_DEPLOYED',
            title: `Token Deployed: $${tokenSymbol} (${chain})`,
            message: `Contract ${result.tokenAddress || 'pending'} berhasil di-deploy via ${resolvedByok ? 'BYOK_VAULT' : 'PLATFORM_ENV'}.`,
            metadata: {
              symbol: tokenSymbol,
              chain,
              tokenAddress: result.tokenAddress || '',
              txHash: result.txHash || '',
              keySource: resolvedByok ? 'BYOK_VAULT' : 'PLATFORM_ENV',
            },
          },
        });
      }
    }

    return NextResponse.json(
      {
        success: isSuccess,
        data: {
          ...result,
          keySource: resolvedByok ? 'BYOK_VAULT' : 'PLATFORM_ENV',
          usedKeyLabel: resolvedByok?.label,
          usedKeyMasked: resolvedByok?.maskedKey,
          launchId: persistedLaunchId,
          creditsBurned: isSuccess ? launchCostCr : 0,
          remainingCredits,
        },
        error: result.status === 'failed' || result.status === 'unknown' ? result.message : undefined,
        timestamp: new Date().toISOString(),
      },
      { status: httpStatus }
    );
  } catch (err: unknown) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'BANKR_DEPLOY_ERROR', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}
