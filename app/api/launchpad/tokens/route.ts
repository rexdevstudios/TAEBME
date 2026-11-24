import { NextRequest, NextResponse } from 'next/server';
import { defaultDraftDbAdapter } from '@packages/shared/db-pool';
import { ApiResponse } from '@packages/shared/contracts/api-contracts';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const statusParam = (req.nextUrl.searchParams.get('status') || 'all').trim().toLowerCase();
    const rawLimit = Number(req.nextUrl.searchParams.get('limit') || 50);
    const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.floor(rawLimit))) : 50;

    let launches = await defaultDraftDbAdapter.getActiveTokenLaunches();
    if (statusParam === 'graduated') {
      launches = launches.filter((l: any) => Boolean(l?.isGraduated));
    } else if (statusParam === 'active' || statusParam === 'curve') {
      launches = launches.filter((l: any) => !Boolean(l?.isGraduated));
    }
    launches = launches.slice(0, limit);

    const response: ApiResponse<typeof launches> = {
      success: true,
      data: launches,
      timestamp: new Date().toISOString(),
    };
    return NextResponse.json(response, {
      status: 200,
      headers: {
        'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=45',
      },
    });
  } catch (err: any) {
    const response: ApiResponse<null> = {
      success: false,
      error: { code: 'FETCH_TOKENS_FAILED', message: err?.message || 'Failed to fetch active tokens' },
      timestamp: new Date().toISOString(),
    };
    return NextResponse.json(response, { status: 500 });
  }
}
