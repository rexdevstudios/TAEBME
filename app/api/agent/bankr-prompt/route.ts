/**
 * app/api/agent/bankr-prompt/route.ts
 *
 * Stateless Bankr Agent API Execution Rail (Phase DK).
 * - POST: Submits a natural-language prompt to Bankr Agent API (POST /agent/prompt)
 *   gated by SIWE session, Rate Limiter, Global Kill-Switch, and BYOK Bankr Vault.
 * - GET ?jobId=...: Polls async Bankr Agent job status (GET /agent/job/{job_id}).
 * - 100% Non-Custodial: Zero private keys in Vercel or Postgres.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireActiveSession } from '@packages/auth/session';
import { rateLimiter } from '@packages/auth/rate-limiter';
import {
  defaultKillSwitchDbAdapter,
  defaultProviderKeyVaultAdapter,
} from '@packages/shared/db-pool';
import {
  getBankrAgentJobStatus,
  submitBankrAgentPrompt,
  validateBankrAgentPromptInput,
} from '@packages/launchpad/bankr-client';

export const dynamic = 'force-dynamic';

async function resolveUserBankrApiKey(walletAddress: string, providerKeyId?: string): Promise<string | undefined> {
  if (!providerKeyId || providerKeyId === 'PLATFORM_DEFAULT') return undefined;
  const resolved = await defaultProviderKeyVaultAdapter.resolveDecryptedKeyForDeploy({
    userIdentifier: walletAddress,
    targetChain: 'base',
    keyId: providerKeyId,
    provider: 'BANKR',
  });
  return resolved?.apiKey;
}

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for') || '127.0.0.1';
    const rateCheck = await rateLimiter.checkRateLimit(`ratelimit:bankr:agent:${ip}`, 15, 60);
    if (!rateCheck.allowed) {
      return NextResponse.json(
        {
          success: false,
          error: 'TOO_MANY_REQUESTS: Bankr Agent rate limit exceeded',
          timestamp: new Date().toISOString(),
        },
        { status: 429 }
      );
    }

    let session;
    try {
      session = await requireActiveSession(req);
    } catch (authErr: unknown) {
      const msg = authErr instanceof Error ? authErr.message : String(authErr);
      const isForbidden = msg.includes('AUTH_ACCOUNT_');
      return NextResponse.json(
        {
          success: false,
          error: isForbidden ? `FORBIDDEN: ${msg}` : `UNAUTHORIZED: ${msg}`,
          timestamp: new Date().toISOString(),
        },
        { status: isForbidden ? 403 : 401 }
      );
    }

    const activeKillSwitches = await defaultKillSwitchDbAdapter.getActiveKillSwitches().catch(() => []);
    const blockedSwitch = activeKillSwitches.find((ks) => {
      const scope = String(ks.scope || '').toUpperCase();
      return ks.isActive && (scope === 'GLOBAL' || scope === 'TRADING' || scope === 'AGENT');
    });
    if (blockedSwitch) {
      return NextResponse.json(
        {
          success: false,
          error: `KILL_SWITCH_ACTIVE: Execution halted by ${blockedSwitch.scope} kill switch (${blockedSwitch.reason || 'admin halt'}).`,
          timestamp: new Date().toISOString(),
        },
        { status: 503 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const check = validateBankrAgentPromptInput(body?.prompt);
    if (!check.valid) {
      return NextResponse.json(
        {
          success: false,
          error: check.errorMessage || 'INVALID_PROMPT',
          timestamp: new Date().toISOString(),
        },
        { status: 400 }
      );
    }

    const providerKeyId = typeof body?.providerKeyId === 'string' ? body.providerKeyId.trim() : undefined;
    let apiKeyOverride: string | undefined;
    if (providerKeyId && providerKeyId !== 'PLATFORM_DEFAULT') {
      try {
        apiKeyOverride = await resolveUserBankrApiKey(session.walletAddress, providerKeyId);
      } catch (err: unknown) {
        return NextResponse.json(
          {
            success: false,
            error: err instanceof Error ? err.message : 'BYOK_BANKR_KEY_ERROR',
            timestamp: new Date().toISOString(),
          },
          { status: 400 }
        );
      }
      if (!apiKeyOverride) {
        return NextResponse.json(
          {
            success: false,
            error: 'BYOK_KEY_NOT_FOUND: Selected Bankr API key was not found in your vault.',
            timestamp: new Date().toISOString(),
          },
          { status: 404 }
        );
      }
    }

    const result = await submitBankrAgentPrompt({
      prompt: check.sanitizedPrompt,
      apiKeyOverride,
    });

    const ok = result.status === 'pending' || result.status === 'completed';
    return NextResponse.json(
      {
        success: ok,
        data: result,
        error: ok ? undefined : result.message,
        timestamp: new Date().toISOString(),
      },
      { status: ok ? 202 : result.status === 'unknown' ? 504 : 422 }
    );
  } catch (err: any) {
    return NextResponse.json(
      {
        success: false,
        error: err?.message || 'BANKR_AGENT_PROMPT_ERROR',
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  try {
    let session;
    try {
      session = await requireActiveSession(req);
    } catch (authErr: unknown) {
      const msg = authErr instanceof Error ? authErr.message : String(authErr);
      const isForbidden = msg.includes('AUTH_ACCOUNT_');
      return NextResponse.json(
        {
          success: false,
          error: isForbidden ? `FORBIDDEN: ${msg}` : `UNAUTHORIZED: ${msg}`,
          timestamp: new Date().toISOString(),
        },
        { status: isForbidden ? 403 : 401 }
      );
    }

    const jobId = (req.nextUrl.searchParams.get('jobId') || '').trim();
    const providerKeyId = (req.nextUrl.searchParams.get('providerKeyId') || '').trim() || undefined;
    if (!jobId) {
      return NextResponse.json(
        { success: false, error: 'MISSING_JOB_ID: jobId query param is required', timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }

    let apiKeyOverride: string | undefined;
    if (providerKeyId && providerKeyId !== 'PLATFORM_DEFAULT') {
      apiKeyOverride = await resolveUserBankrApiKey(session.walletAddress, providerKeyId).catch(() => undefined);
    }

    const result = await getBankrAgentJobStatus({ jobId, apiKeyOverride });
    const ok = result.status === 'pending' || result.status === 'completed';
    return NextResponse.json(
      {
        success: ok,
        data: result,
        error: ok ? undefined : result.message,
        timestamp: new Date().toISOString(),
      },
      { status: ok ? 200 : result.status === 'unknown' ? 504 : 422, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err: any) {
    return NextResponse.json(
      {
        success: false,
        error: err?.message || 'BANKR_AGENT_JOB_STATUS_ERROR',
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
