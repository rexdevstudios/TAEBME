// ============================================================================
// RTRADER CRYPTOGRAPHIC SESSION MANAGER & AUTHORITATIVE RBAC AUTHENTICATOR
// ============================================================================
//
// Invariants:
// 1. Session tokens are signed using HMAC-SHA256 with MASTER_VAULT_KEY or SESSION_SECRET.
// 2. Client-provided roles or decoded strings are NEVER trusted as security boundaries.
// 3. Roles and permissions are resolved authoritatively server-side (Admin public address,
//    Postgres user_roles, or DB entities).
// 4. Non-custodial guarantee: Never stores or handles private keys.
// ============================================================================

import crypto from 'crypto';
import { ethers } from 'ethers';
import { Role } from '../shared/types/domain';
import { Capability, RbacGuard, UserContext } from './rbac-middleware';
import { getDbPool, isDatabaseConfigured } from '../shared/db-pool';
import { getAppEnvironment } from '../shared/env-config';

const TOKEN_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8 hours TTL

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

export interface DecodedSession {
  userId: string;
  walletAddress: string;
  issuedAt: number;
  nonce: string;
}

export interface AuthenticatedUserSession {
  user: UserContext;
  walletAddress: string;
  token: string;
  issuedAt: number;
}

/**
 * Creates a cryptographically signed session token.
 * Format: base64(<userId>:<walletAddress>:<issuedAt>:<nonce>:<hmacSha256>)
 */
export function createSessionToken(params: {
  userId: string;
  walletAddress: string;
  nonce?: string;
}): string {
  const secret = getSessionSecret();
  const normalizedAddress = ethers.getAddress(params.walletAddress);
  const issuedAt = Date.now().toString();
  const nonce = params.nonce || crypto.randomBytes(8).toString('hex');
  const payload = `${params.userId}:${normalizedAddress}:${issuedAt}:${nonce}`;

  const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const fullToken = `${payload}:${hmac}`;

  return Buffer.from(fullToken, 'utf8').toString('base64');
}

/**
 * Cryptographically verifies and decodes a session token.
 * Returns null if token is missing, expired, malformed, or has an invalid HMAC signature.
 */
export function verifySessionToken(token?: string | null): DecodedSession | null {
  if (!token || typeof token !== 'string' || token.trim().length < 32) {
    return null;
  }

  try {
    const raw = Buffer.from(token.trim(), 'base64').toString('utf8');
    const parts = raw.split(':');

    // Expected format: [userId, walletAddress, issuedAt, nonce, hmacSignature]
    if (parts.length < 5) {
      return null;
    }

    const [userId, walletAddress, issuedAtStr, nonce, receivedSig] = parts;

    if (!userId || !walletAddress || !issuedAtStr || !nonce || !receivedSig) {
      return null;
    }

    if (!ethers.isAddress(walletAddress)) {
      return null;
    }

    const issuedAt = parseInt(issuedAtStr, 10);
    if (isNaN(issuedAt) || Date.now() - issuedAt > TOKEN_MAX_AGE_MS || issuedAt > Date.now() + 60000) {
      return null; // Expired or future timestamp
    }

    const secret = getSessionSecret();
    const payload = `${userId}:${walletAddress}:${issuedAtStr}:${nonce}`;
    const expectedSig = crypto.createHmac('sha256', secret).update(payload).digest('hex');

    const receivedBuf = Buffer.from(receivedSig, 'hex');
    const expectedBuf = Buffer.from(expectedSig, 'hex');

    if (receivedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(receivedBuf, expectedBuf)) {
      return null; // HMAC verification failed
    }

    return {
      userId,
      walletAddress: ethers.getAddress(walletAddress),
      issuedAt,
      nonce,
    };
  } catch {
    return null;
  }
}

/**
 * Authoritatively returns and validates the configured platform admin public address.
 *
 * Security Invariants (AGENTS.md Invariant 3):
 * 1. Must be a valid 42-character Ethereum public address (ethers.isAddress).
 * 2. Strictly rejects 64-character private keys mistakenly provided in env.
 * 3. In production, logs a structured warning if missing so administrators are aware.
 */
export function getConfiguredAdminWallet(): string | null {
  const raw = process.env.ADMIN_WALLET_PUBLIC_ADDRESS?.trim();
  if (!raw) {
    if (process.env.NODE_ENV === 'production') {
      console.warn('[ADMIN_CONFIG_WARNING] Running in production without configured ADMIN_WALLET_PUBLIC_ADDRESS. Admin access will rely exclusively on PostgreSQL user_roles table.');
    }
    return null;
  }

  // Reject private keys mistakenly configured as public address (64 hex characters or 66 with 0x)
  const clean = raw.startsWith('0x') ? raw.slice(2) : raw;
  if (clean.length === 64) {
    console.error('[SECURITY_VIOLATION] ADMIN_WALLET_PUBLIC_ADDRESS appears to be a 64-character private key! AGENTS.md Invariant 3 violated. Admin address must be a public address only.');
    return null;
  }

  if (!ethers.isAddress(raw)) {
    console.error(`[CONFIG_ERROR] ADMIN_WALLET_PUBLIC_ADDRESS "${raw}" is not a valid Ethereum address.`);
    return null;
  }

  return ethers.getAddress(raw).toLowerCase();
}

/**
 * Authoritatively resolves user roles from the single source of truth:
 * 1. ADMIN_WALLET_PUBLIC_ADDRESS check
 * 2. Non-production test admin allowlist
 * 3. PostgreSQL user_roles table
 * 4. Default: ['TRADER']
 */
export async function resolveUserRoles(
  walletAddress: string,
  _userId?: string
): Promise<{ roles: Role[]; status: 'ACTIVE' | 'SUSPENDED' | 'FROZEN' }> {
  const normalized = ethers.getAddress(walletAddress);
  const normalizedLower = normalized.toLowerCase();

  // 1. Check configured platform admin wallet (Non-custodial public address)
  const configuredAdmin = getConfiguredAdminWallet();
  if (configuredAdmin && normalizedLower === configuredAdmin) {
    return {
      roles: ['SUPER_ADMIN', 'SYSTEM_ADMIN', 'LAUNCH_ADMIN', 'RISK_ADMIN', 'TRADER', 'CREATOR'],
      status: 'ACTIVE',
    };
  }

  // 2. Non-production simulated test admin addresses
  if (process.env.NODE_ENV !== 'production') {
    const isTestAdmin =
      normalizedLower === '0x90f79bf6eb2c4f870365e785982e1f101e93b906'.toLowerCase() ||
      normalizedLower === '0xADMIN99999999999999999999999999999999999'.toLowerCase();
    if (isTestAdmin) {
      return {
        roles: ['SUPER_ADMIN', 'SYSTEM_ADMIN', 'LAUNCH_ADMIN', 'RISK_ADMIN', 'TRADER', 'CREATOR'],
        status: 'ACTIVE',
      };
    }
  }

  // 3. Query PostgreSQL SSOT (if database is configured)
  if (isDatabaseConfigured()) {
    const pool = getDbPool();
    if (!pool) {
      throw new Error('DATABASE_UNAVAILABLE: Database is configured but connection pool failed to initialize.');
    }
    try {
      const res = await pool.query(
        `SELECT u.status, array_agg(ur.role) as roles
         FROM wallets w
         JOIN users u ON u.id = w.user_id
         LEFT JOIN user_roles ur ON ur.user_id = u.id
         WHERE LOWER(w.address) = LOWER($1)
         GROUP BY u.status`,
        [normalizedLower]
      );

      if (res.rows.length > 0) {
        const row = res.rows[0];
        const status = (row.status as 'ACTIVE' | 'SUSPENDED' | 'FROZEN') || 'ACTIVE';
        const rawRoles: string[] = (row.roles || []).filter(Boolean);
        const roles: Role[] = rawRoles.length > 0
          ? (rawRoles as Role[])
          : ['TRADER'];

        return { roles, status };
      }
    } catch (dbErr: any) {
      // Fail closed: Do NOT silently convert database failure into ACTIVE TRADER status!
      throw new Error(`DATABASE_UNAVAILABLE: Failed to resolve authoritative user account status: ${dbErr?.message || 'Database query error'}`);
    }
  }

  // 4. Default verified user role for unregistered wallet / in-memory mode
  return {
    roles: ['TRADER'],
    status: 'ACTIVE',
  };
}

/**
 * Extracts and cryptographically authenticates session from NextRequest or Request headers/cookies.
 */
export async function authenticateSession(req: Request | { headers: Headers; cookies?: any }): Promise<AuthenticatedUserSession | null> {
  let token: string | null = null;

  // 1. Authorization header: "Bearer <token>"
  const authHeader = req.headers.get('Authorization') || req.headers.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  }

  // 2. Cookie header: "rtrader_session=<token>"
  if (!token) {
    if ('cookies' in req && typeof req.cookies?.get === 'function') {
      token = req.cookies.get('rtrader_session')?.value || null;
    } else {
      const cookieHeader = req.headers.get('cookie') || req.headers.get('Cookie');
      if (cookieHeader) {
        const match = cookieHeader.match(/rtrader_session=([^;]+)/);
        if (match) token = match[1];
      }
    }
  }

  if (!token) return null;

  const session = verifySessionToken(token);
  if (!session) return null;

  const { roles, status } = await resolveUserRoles(session.walletAddress, session.userId);

  return {
    user: {
      userId: session.userId,
      roles,
      status,
    },
    walletAddress: session.walletAddress,
    token,
    issuedAt: session.issuedAt,
  };
}

/**
 * Authorizes that the request contains a valid authenticated session AND possesses the requested capability.
 * Throws standard error if unauthenticated (401) or unauthorized by RBAC (403).
 */
export async function requireCapability(
  req: Request | { headers: Headers; cookies?: any },
  capability: Capability
): Promise<AuthenticatedUserSession> {
  const session = await authenticateSession(req);
  if (!session) {
    throw new Error('UNAUTHORIZED: Valid cryptographic SIWE session token is required.');
  }

  // Throws RBAC_FORBIDDEN or AUTH_ACCOUNT_<status>
  RbacGuard.authorize(session.user, capability);

  return session;
}
