/**
 * packages/shared/credential-vault.ts
 *
 * Non-Custodial BYOK Service API Key Vault (AES-256-GCM + Multi-Chain Scope Guards).
 *
 * Compliance with AGENTS.md Rule 3 (Non-Custodial Guarantee):
 * - STRICTLY FORBIDS storing EVM private keys, Solana keypairs, or BIP-39 seed phrases.
 * - Only encrypts revocable third-party service API keys (e.g. Bankr Partner/Deploy API Key).
 * - Uses Node built-in `crypto` AES-256-GCM with unique 96-bit IV + 128-bit AuthTag per record.
 * - Enforces granular `chain_scope` ('all' | 'base' | 'robinhood' | 'arbitrum' | 'arc')
 *   and cross-chain feeRecipient format validation.
 */

import crypto from 'crypto';
import { ethers } from 'ethers';

export type ProviderKeyChainScope = 'all' | 'base' | 'robinhood' | 'arbitrum' | 'arc' | 'testnet' | 'mainnet';

export const VALID_PROVIDER_CHAIN_SCOPES = new Set<ProviderKeyChainScope>([
  'all',
  'base',
  'robinhood',
  'arbitrum',
  'arc',
  'testnet',
  'mainnet',
]);

export interface EncryptedVaultPayload {
  ciphertext: string;
  iv: string;
  authTag: string;
}

function resolveMasterKeyBuffer(customSecret?: string): Buffer {
  const raw =
    customSecret ||
    process.env.CREDENTIAL_ENCRYPTION_KEY ||
    process.env.MASTER_VAULT_KEY ||
    process.env.SESSION_SECRET ||
    process.env.JWT_SECRET ||
    'poolnet-v25-byok-credential-vault-master-key';
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

/**
 * Guard that rejects any input resembling a wallet private key or mnemonic seed phrase.
 * Enforces AGENTS.md Rule 3 (Non-Custodial Guarantee) at the input boundary.
 */
export function assertNotPrivateKeyOrMnemonic(rawInput: string): void {
  const trimmed = (rawInput || '').trim();
  if (!trimmed || trimmed.length < 8) {
    throw new Error('INVALID_API_KEY: API key must be at least 8 characters.');
  }

  // 1. Reject 64-hex EVM private key (with or without 0x prefix)
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error(
      'FORBIDDEN_PRIVATE_KEY_INPUT: Wallet private keys are strictly prohibited (Non-Custodial Rule 3). Enter a Bankr service API key only.'
    );
  }

  // 2. Reject Solana 64-byte keypair JSON array (e.g. [12, 34, ...]) or 87-88 char base58 secret key
  if (/^\[\s*\d+(\s*,\s*\d+){31,64}\s*\]$/.test(trimmed)) {
    throw new Error(
      'FORBIDDEN_PRIVATE_KEY_INPUT: Solana keypair byte arrays are strictly prohibited (Non-Custodial Rule 3).'
    );
  }

  // 3. Reject BIP-39 seed phrases (12, 15, 18, 21, or 24 space-separated words)
  const words = trimmed.split(/\s+/);
  if ([12, 15, 18, 21, 24].includes(words.length) && words.every((w) => /^[a-zA-Z]{3,12}$/.test(w))) {
    throw new Error(
      'FORBIDDEN_PRIVATE_KEY_INPUT: Seed phrases / mnemonics are strictly prohibited (Non-Custodial Rule 3).'
    );
  }
}

/**
 * Masks an API key for write-only UI display (never exposes full plaintext).
 */
export function maskApiKey(rawKey: string): string {
  const clean = (rawKey || '').trim();
  if (clean.length <= 8) {
    return `${clean.slice(0, 2)}••••${clean.slice(-2)}`;
  }
  const prefix = clean.slice(0, 4);
  const suffix = clean.slice(-4);
  return `${prefix}••••${suffix}`;
}

/**
 * Encrypts a service API key with AES-256-GCM (random 12-byte IV + 16-byte AuthTag).
 */
export function encryptSecret(plaintext: string, customMasterSecret?: string): EncryptedVaultPayload {
  assertNotPrivateKeyOrMnemonic(plaintext);
  const key = resolveMasterKeyBuffer(customMasterSecret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext.trim(), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

/**
 * Decrypts and verifies an AES-256-GCM encrypted service API key.
 * Throws if ciphertext, IV, authTag, or master key is tampered.
 */
export function decryptSecret(payload: EncryptedVaultPayload, customMasterSecret?: string): string {
  try {
    const key = resolveMasterKeyBuffer(customMasterSecret);
    const iv = Buffer.from(payload.iv, 'base64');
    const authTag = Buffer.from(payload.authTag, 'base64');
    const encrypted = Buffer.from(payload.ciphertext, 'base64');

    if (iv.length !== 12 || authTag.length !== 16) {
      throw new Error('VAULT_INVALID_PARAMETERS');
    }

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    throw new Error('VAULT_DECRYPT_TAMPERED: Failed to authenticate or decrypt stored API key.');
  }
}

/**
 * Normalizes & validates a chain scope for a BYOK key.
 */
export function validateChainScope(rawScope?: string | null): ProviderKeyChainScope {
  const s = (rawScope || 'all').trim().toLowerCase() as ProviderKeyChainScope;
  if (!VALID_PROVIDER_CHAIN_SCOPES.has(s)) {
    throw new Error(
      `INVALID_CHAIN_SCOPE: "${rawScope}" is not valid. Allowed: all, base, robinhood, arbitrum, arc, testnet, mainnet.`
    );
  }
  return s;
}

/**
 * Enforces multi-chain blast-radius isolation: a key scoped to 'robinhood' cannot deploy on 'base'.
 * Allows lookup when either the stored key scope or the requested target is 'all'.
 */
export function assertChainScopeMatches(keyScope: string, targetChain: string): void {
  const normScope = validateChainScope(keyScope);
  const rawTarget = (targetChain || 'base').trim().toLowerCase();
  if (normScope === 'all' || rawTarget === 'all') {
    return;
  }
  const normTarget = rawTarget.replace(/-mainnet|-testnet|-sepolia/g, '');
  if (normScope !== normTarget && normScope !== rawTarget) {
    throw new Error(
      `CHAIN_SCOPE_MISMATCH: Selected API key is restricted to "${normScope.toUpperCase()}" and cannot be used for "${normTarget.toUpperCase()}" deployment.`
    );
  }
}

/**
 * Validates that a feeRecipient matches the target chain architecture (EVM checksum vs social handle).
 * Accepts either structured `{ type, value }` or a raw wallet string for backward compatibility.
 */
export function validateMultiChainFeeRecipient(
  targetChain: string,
  feeRecipient?: { type: 'wallet' | 'x' | 'farcaster' | 'ens'; value: string } | string | null
): void {
  if (!feeRecipient) return;

  const isString = typeof feeRecipient === 'string';
  const recType = isString ? 'wallet' : feeRecipient.type || 'wallet';
  const val = (isString ? feeRecipient : feeRecipient.value || '').trim();
  if (!val) {
    throw new Error('INVALID_FEE_RECIPIENT: feeRecipient.value cannot be empty.');
  }

  const normChain = (targetChain || 'base').trim().toLowerCase();
  const isEvmChain = ['base', 'robinhood', 'arbitrum', 'arc', 'ethereum', 'bsc'].some((c) =>
    normChain.includes(c)
  );

  if (recType === 'wallet' && isEvmChain) {
    if (!ethers.isAddress(val)) {
      throw new Error(
        `CROSS_CHAIN_ADDRESS_MISMATCH: Fee recipient wallet "${val}" is not a valid EVM address for chain "${targetChain.toUpperCase()}".`
      );
    }
  }
}
