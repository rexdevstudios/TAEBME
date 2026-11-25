/**
 * packages/agent/owned-wallet-proof.ts
 *
 * Stateless Cryptographic Proof-of-Ownership Helper for Multi-Owned Sub-Wallet Allowlist (Phase EG).
 *
 * Security invariants:
 * - 100% Non-Custodial: NEVER accepts or handles private keys or seed phrases.
 * - Challenge is cryptographically bound via HMAC-SHA256 to (primaryWallet, subWalletAddress, nonce, expiresAt).
 * - Verification recovers the ECDSA signer using ethers.verifyMessage() and requires an exact
 *   case-insensitive match against `subWalletAddress`.
 */

import crypto from 'crypto';
import { ethers } from 'ethers';

export interface OwnedSubWalletChallenge {
  primaryWallet: string;
  subWalletAddress: string;
  nonce: string;
  expiresAt: string;
  message: string;
  challengeToken: string;
}

export interface OwnedSubWalletVerifyResult {
  valid: boolean;
  code?:
    | 'INVALID_ADDRESS'
    | 'SAME_AS_PRIMARY'
    | 'INVALID_CHALLENGE_TOKEN'
    | 'CHALLENGE_EXPIRED'
    | 'CHALLENGE_BINDING_MISMATCH'
    | 'INVALID_SIGNATURE';
  reason?: string;
  normalizedSubWallet?: string;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

function resolveProofHmacSecret(overrideSecret?: string): string {
  return (
    overrideSecret ||
    process.env.MASTER_VAULT_KEY ||
    process.env.SESSION_SECRET ||
    process.env.CREDENTIAL_ENCRYPTION_KEY ||
    'poolnet-owned-subwallet-proof-hmac-v1'
  );
}

function signChallengePayload(payloadB64: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payloadB64, 'utf8').digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

export function buildOwnedSubWalletMessage(params: {
  primaryWallet: string;
  subWalletAddress: string;
  nonce: string;
  expiresAt: string;
}): string {
  return [
    'POOLNET Owned Sub-Wallet Allowlist Verification',
    `Primary Account Wallet: ${params.primaryWallet.toLowerCase()}`,
    `Sub-Wallet Being Linked: ${params.subWalletAddress.toLowerCase()}`,
    'Action: Authorize internal AI Copilot transfers to this verified owned wallet.',
    `Nonce: ${params.nonce}`,
    `Expires At: ${params.expiresAt}`,
  ].join('\n');
}

export function buildOwnedSubWalletChallenge(params: {
  primaryWallet: string;
  subWalletAddress: string;
  secret?: string;
  ttlMs?: number;
}): OwnedSubWalletChallenge {
  const primaryClean = String(params.primaryWallet || '').trim();
  const subClean = String(params.subWalletAddress || '').trim();

  if (!ethers.isAddress(primaryClean) || !ethers.isAddress(subClean)) {
    throw new Error('INVALID_ADDRESS: Valid 0x EVM primaryWallet and subWalletAddress are required.');
  }

  const primaryNorm = primaryClean.toLowerCase();
  const subNorm = subClean.toLowerCase();
  if (primaryNorm === subNorm) {
    throw new Error('SAME_AS_PRIMARY: Your primary SIWE wallet is already in your owned-wallet allowlist.');
  }

  const nonce = crypto.randomBytes(16).toString('hex');
  const ttl = Math.max(60_000, Math.min(30 * 60_000, Number(params.ttlMs || DEFAULT_TTL_MS)));
  const expiresAtMs = Date.now() + ttl;
  const expiresAt = new Date(expiresAtMs).toISOString();

  const message = buildOwnedSubWalletMessage({
    primaryWallet: primaryNorm,
    subWalletAddress: subNorm,
    nonce,
    expiresAt,
  });

  const payloadObj = {
    p: primaryNorm,
    s: subNorm,
    n: nonce,
    e: expiresAtMs,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
  const mac = signChallengePayload(payloadB64, resolveProofHmacSecret(params.secret));

  return {
    primaryWallet: primaryNorm,
    subWalletAddress: subNorm,
    nonce,
    expiresAt,
    message,
    challengeToken: `${payloadB64}.${mac}`,
  };
}

export function verifyOwnedSubWalletProof(params: {
  primaryWallet: string;
  subWalletAddress: string;
  signature: string;
  challengeToken: string;
  message?: string;
  secret?: string;
  nowMs?: number;
}): OwnedSubWalletVerifyResult {
  const primaryClean = String(params.primaryWallet || '').trim();
  const subClean = String(params.subWalletAddress || '').trim();
  if (!ethers.isAddress(primaryClean) || !ethers.isAddress(subClean)) {
    return {
      valid: false,
      code: 'INVALID_ADDRESS',
      reason: 'INVALID_ADDRESS: Valid 0x EVM addresses are required.',
    };
  }

  const primaryNorm = primaryClean.toLowerCase();
  const subNorm = subClean.toLowerCase();
  if (primaryNorm === subNorm) {
    return {
      valid: false,
      code: 'SAME_AS_PRIMARY',
      reason: 'SAME_AS_PRIMARY: Primary wallet is already automatically allowlisted.',
    };
  }

  const token = String(params.challengeToken || '').trim();
  const dotIdx = token.indexOf('.');
  if (dotIdx <= 0 || dotIdx === token.length - 1) {
    return {
      valid: false,
      code: 'INVALID_CHALLENGE_TOKEN',
      reason: 'INVALID_CHALLENGE_TOKEN: Malformed challenge token.',
    };
  }

  const payloadB64 = token.slice(0, dotIdx);
  const providedMac = token.slice(dotIdx + 1);
  const expectedMac = signChallengePayload(payloadB64, resolveProofHmacSecret(params.secret));
  if (!safeEqualHex(providedMac, expectedMac)) {
    return {
      valid: false,
      code: 'INVALID_CHALLENGE_TOKEN',
      reason: 'INVALID_CHALLENGE_TOKEN: Challenge MAC verification failed.',
    };
  }

  let parsed: { p?: string; s?: string; n?: string; e?: number };
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return {
      valid: false,
      code: 'INVALID_CHALLENGE_TOKEN',
      reason: 'INVALID_CHALLENGE_TOKEN: Unable to parse challenge payload.',
    };
  }

  const now = Number.isFinite(params.nowMs) ? Number(params.nowMs) : Date.now();
  if (!parsed.e || now > parsed.e) {
    return {
      valid: false,
      code: 'CHALLENGE_EXPIRED',
      reason: 'CHALLENGE_EXPIRED: Proof challenge expired. Request a new challenge.',
    };
  }

  if (parsed.p !== primaryNorm || parsed.s !== subNorm || !parsed.n) {
    return {
      valid: false,
      code: 'CHALLENGE_BINDING_MISMATCH',
      reason: 'CHALLENGE_BINDING_MISMATCH: Challenge does not match primary wallet or target sub-wallet.',
    };
  }

  const expectedMessage = buildOwnedSubWalletMessage({
    primaryWallet: primaryNorm,
    subWalletAddress: subNorm,
    nonce: parsed.n,
    expiresAt: new Date(parsed.e).toISOString(),
  });

  if (params.message && params.message.trim() !== expectedMessage.trim()) {
    return {
      valid: false,
      code: 'CHALLENGE_BINDING_MISMATCH',
      reason: 'CHALLENGE_BINDING_MISMATCH: Signed message text does not match issued challenge.',
    };
  }

  const sig = String(params.signature || '').trim();
  if (!sig || !sig.startsWith('0x')) {
    return {
      valid: false,
      code: 'INVALID_SIGNATURE',
      reason: 'INVALID_SIGNATURE: Cryptographic signature is required.',
    };
  }

  try {
    const recovered = ethers.verifyMessage(expectedMessage, sig);
    if (recovered.toLowerCase() !== subNorm) {
      return {
        valid: false,
        code: 'INVALID_SIGNATURE',
        reason: 'INVALID_SIGNATURE: Recovered signer does not match target sub-wallet address.',
      };
    }
  } catch {
    return {
      valid: false,
      code: 'INVALID_SIGNATURE',
      reason: 'INVALID_SIGNATURE: Failed to verify ECDSA signature.',
    };
  }

  return {
    valid: true,
    normalizedSubWallet: subNorm,
  };
}
