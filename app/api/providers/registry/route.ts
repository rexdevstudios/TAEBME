/**
 * app/api/providers/registry/route.ts
 *
 * Public Read-Only Modular Provider Registry Endpoint.
 * Exposes live supported CEX, Launchpad, LLM (including BytePlus default), and Webhook providers.
 */

import { NextResponse } from 'next/server';
import { ProviderRegistry } from '@packages/providers/registry';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(
    {
      success: true,
      data: {
        defaultLlm: ProviderRegistry.getDefaultLlmProvider(),
        providers: ProviderRegistry.listAll(),
      },
      timestamp: new Date().toISOString(),
    },
    { status: 200 }
  );
}
