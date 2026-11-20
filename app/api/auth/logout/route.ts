import { NextRequest, NextResponse } from 'next/server';
import { ApiResponse } from '@packages/shared/contracts/api-contracts';

export async function POST(_req: NextRequest) {
  try {
    const response: ApiResponse<{ loggedOut: boolean }> = {
      success: true,
      data: { loggedOut: true },
      timestamp: new Date().toISOString(),
    };

    const nextResponse = NextResponse.json(response, { status: 200 });

    // Invalidate and expire the HttpOnly session cookie
    nextResponse.cookies.set('rtrader_session', '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 0,
      path: '/',
    });

    return nextResponse;
  } catch (err) {
    const response: ApiResponse<null> = {
      success: false,
      error: { code: 'LOGOUT_ERROR', message: (err as Error).message },
      timestamp: new Date().toISOString(),
    };
    return NextResponse.json(response, { status: 500 });
  }
}
