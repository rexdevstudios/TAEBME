// ============================================================================
// NEXT.JS EDGE MIDDLEWARE — Auth Route Protection & Security Headers
// ============================================================================
//
// INVARIANT (MASTER_PROMPT.md §Core Path Protection & Auth):
//   - Middleware intercepts ALL requests before they reach API Route Handlers.
//   - Auth routes (/api/auth/challenge, /api/auth/verify) are PUBLIC — rate
//     limiter inside the handler itself enforces DOS protection.
//   - All other /api/* routes check for a valid session token in cookies or
//     the Authorization header. Returns 401 if missing.
//   - Frontend pages are public (no server session required for static assets).
//   - Middleware is STATELESS (Edge Runtime compatible). No DB calls here.
//   - Redis/Postgres/external services are NOT invoked in middleware.
//
// ============================================================================

import { NextRequest, NextResponse } from 'next/server';

// Routes that are publicly accessible without a session token for ALL HTTP methods
const PUBLIC_API_PATHS = new Set([
  '/api/auth/challenge',
  '/api/auth/verify',
  '/api/auth/session',   // Session revalidation is public
  '/api/auth/logout',    // Invalidate session cookie is public
  '/api/billing/plans',   // Read-only plan listing is public
  '/api/system/overview', // Health check is public
  '/api/market/chart',    // Chart data is public read-only
  '/api/market/macro',    // DefiLlama macro TVL signal is public read-only
  '/api/launchpad/tokens', // Public active token list from Neon SSOT
  // NOTE: /api/launchpad/publish is PROTECTED — requires PUBLISH_LAUNCH capability (H-01 fix)
  // NOTE: /api/launchpad/graduate POST is PROTECTED — requires GRADUATE_LAUNCH capability (C-01 fix)
  // NOTE: /api/launchpad/bounty/settle is PROTECTED — requires auth session (C-02 fix)
  // NOTE: /api/launchpad/bounty/claim POST is PROTECTED — requires auth session (C-04 fix)
  // NOTE: /api/launchpad/bounty/verify-hodl is PROTECTED — requires auth session
  '/api/launchpad/bounty', // Public bounty campaigns list from Neon SSOT
  '/api/launchpad/curve-volatility', // Public curve slope parameters
  '/api/launchpad/keeper', // Keeper automation handles CRON_SECRET internally
  '/api/launchpad/webhook', // Webhook receiver handles signature/secret internally
]);

// Routes that are publicly accessible ONLY for GET requests (mutating requests like POST require auth session)
const PUBLIC_GET_ONLY_PATHS = new Set([
  '/api/launchpad/graduate', // GET (graduation status read) is public; POST is protected
]);

// Security headers applied to ALL responses
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options':    'nosniff',
  'X-Frame-Options':           'DENY',
  'X-XSS-Protection':          '1; mode=block',
  'Referrer-Policy':           'strict-origin-when-cross-origin',
  'Permissions-Policy':         'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
};

function applySecurityHeaders(response: NextResponse): NextResponse {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

function extractBearerToken(req: NextRequest): string | null {
  // Check Authorization header: "Bearer <token>"
  const authHeader = req.headers.get('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }
  // Check session cookie (set by /api/auth/verify on success)
  const sessionCookie = req.cookies.get('rtrader_session')?.value;
  if (sessionCookie) return sessionCookie;

  return null;
}

function getSessionSecret(): string {
  const masterKey = process.env.MASTER_VAULT_KEY?.trim();
  const sessionSecret = process.env.SESSION_SECRET?.trim();
  const rawSecret = masterKey || sessionSecret;

  const appEnv = (process.env.APP_ENV || process.env.NEXT_PUBLIC_APP_ENV)?.toLowerCase()?.trim();
  const isProductionLike = process.env.NODE_ENV === 'production' || appEnv === 'production' || appEnv === 'testnet';

  if (!rawSecret) {
    if (isProductionLike) {
      throw new Error(
        'FATAL_CONFIG_ERROR: Session secret (MASTER_VAULT_KEY or SESSION_SECRET) must be set in production/testnet.'
      );
    }
    const envTag = appEnv || 'development';
    return `rtrader-default-dev-secret-32bytes-hex-pad0011:${envTag}`;
  }

  if (isProductionLike && rawSecret.length < 32) {
    throw new Error(
      'FATAL_CONFIG_ERROR: Session secret (MASTER_VAULT_KEY or SESSION_SECRET) must be at least 32 characters in production/testnet.'
    );
  }

  // Cryptographically bind secret to active environment when configured to prevent cross-environment token replay
  if (appEnv) {
    return `${rawSecret}:${appEnv}`;
  }
  return rawSecret;
}

async function verifyHmacSignature(secret: string, payload: string, signatureHex: string): Promise<boolean> {
  if (signatureHex.length !== 64) return false;
  try {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const sigBytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      const byte = parseInt(signatureHex.slice(i * 2, i * 2 + 2), 16);
      if (isNaN(byte)) return false;
      sigBytes[i] = byte;
    }

    const data = encoder.encode(payload);
    return await crypto.subtle.verify('HMAC', key, sigBytes, data);
  } catch {
    return false;
  }
}

async function isValidSessionToken(token: string): Promise<boolean> {
  // Stateless cryptographic validation for Edge middleware:
  // Session tokens are structured as: base64(<userId>:<walletAddress>:<issuedAt>:<nonce>:<hmacSha256>)
  if (!token || token.length < 32) return false;
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const parts = decoded.split(':');
    // Session token structure: userId:walletAddress:issuedAt:nonce:hmacSignature = 5 parts
    if (parts.length < 5) return false;
    const [userId, walletAddress, issuedAtStr, nonce, sig] = parts;
    if (!userId || !walletAddress || !issuedAtStr || !nonce || !sig) return false;

    // Check issuedAt timestamp
    const issuedAt = parseInt(issuedAtStr, 10);
    if (isNaN(issuedAt) || issuedAt <= 0) return false;

    // Check TTL (8 hours = 28,800,000 ms) and clock skew (60s grace)
    const TOKEN_MAX_AGE_MS = 8 * 60 * 60 * 1000;
    if (Date.now() - issuedAt > TOKEN_MAX_AGE_MS || issuedAt > Date.now() + 60000) return false;

    // Cryptographic HMAC-SHA256 verification using Web Crypto API (Edge Runtime native)
    const secret = getSessionSecret();
    const payload = `${userId}:${walletAddress}:${issuedAtStr}:${nonce}`;
    return await verifyHmacSignature(secret, payload, sig);
  } catch {
    return false;
  }
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // --- Apply security headers to ALL responses ---
  const response = NextResponse.next();

  // --- API route protection ---
  if (pathname.startsWith('/api/')) {
    // Check GET-only public paths first
    if (PUBLIC_GET_ONLY_PATHS.has(pathname)) {
      if (req.method === 'GET') {
        return applySecurityHeaders(response);
      }
      // Non-GET methods (POST, PUT, DELETE) fall through to session check below
    } else if (PUBLIC_API_PATHS.has(pathname)) {
      // Allow general public API paths through without session check
      return applySecurityHeaders(response);
    }

    // Protected API routes require a valid session token
    const token = extractBearerToken(req);

    if (!token || !(await isValidSessionToken(token))) {
      const errorResponse = NextResponse.json(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication required. Please sign in with your wallet via SIWE.',
          },
          timestamp: new Date().toISOString(),
        },
        { status: 401 }
      );
      return applySecurityHeaders(errorResponse);
    }

    // Valid token — forward request with security headers
    return applySecurityHeaders(response);
  }

  // --- Frontend pages pass through (public, no auth wall on UI) ---
  return applySecurityHeaders(response);
}

export const config = {
  matcher: [
    /*
     * Match all request paths EXCEPT:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico
     * - public assets
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.png$|.*\\.jpg$|.*\\.svg$).*)',
  ],
};
