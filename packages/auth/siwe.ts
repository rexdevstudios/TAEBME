import { ethers } from 'ethers';
import { getSiweConfig } from '../shared/env-config';

export interface SiweChallenge {
  nonce: string;
  domain: string;
  address: string;
  statement: string;
  uri: string;
  version: string;
  chainId: number;
  issuedAt: string;
  expirationTime: string;
}

export interface ParsedSiweMessage {
  domain: string;
  address?: string;
  statement?: string;
  uri?: string;
  version?: string;
  chainId?: number;
  nonce?: string;
  issuedAt?: string;
  expirationTime?: string;
}

export interface SessionPayload {
  userId: string;
  walletAddress: string;
  roles: string[];
  chainType: 'EVM' | 'SOLANA';
  iat: number;
  exp: number;
}

export class SiweAuthService {
  private static readonly STATEMENT = 'Sign in to Degen Launchpad & Trading Terminal Platform';

  /**
   * Generasi Nonce & Challenge Message untuk SIWE Login
   */
  static generateChallenge(
    domain?: string,
    walletAddress?: string,
    uri?: string,
    chainId?: number
  ): { challenge: SiweChallenge; messageText: string } {
    const envConfig = getSiweConfig();
    const finalDomain = domain || envConfig.domain;
    const finalUri = uri || envConfig.uri;
    const finalChainId = chainId || envConfig.chainId;
    const finalAddress = walletAddress ? ethers.getAddress(walletAddress) : '0x0000000000000000000000000000000000000000';

    const nonce = ethers.hexlify(ethers.randomBytes(16)).substring(2);
    const issuedAt = new Date().toISOString();
    const expirationTime = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 menit expiry

    const challenge: SiweChallenge = {
      nonce,
      domain: finalDomain,
      address: finalAddress,
      statement: this.STATEMENT,
      uri: finalUri,
      version: '1',
      chainId: finalChainId,
      issuedAt,
      expirationTime,
    };

    const messageText = `${finalDomain} wants you to sign in with your Ethereum account:\n` +
      `${finalAddress}\n\n` +
      `${this.STATEMENT}\n\n` +
      `URI: ${finalUri}\n` +
      `Version: 1\n` +
      `Chain ID: ${finalChainId}\n` +
      `Nonce: ${nonce}\n` +
      `Issued At: ${issuedAt}\n` +
      `Expiration Time: ${expirationTime}`;

    return { challenge, messageText };
  }

  /**
   * Parse an EIP-4361 standard SIWE message text
   */
  static parseMessage(messageText: string): ParsedSiweMessage | null {
    if (!messageText || typeof messageText !== 'string') return null;

    const parsed: ParsedSiweMessage = { domain: '' };

    // Standard EIP-4361 header: "<domain> wants you to sign in with your Ethereum account:\n<address>"
    const eip4361HeaderMatch = messageText.match(/^([^\n\r]+) wants you to sign in with your Ethereum account:\r?\n([^\n\r]+)/m);
    if (!eip4361HeaderMatch) {
      return null;
    }
    parsed.domain = eip4361HeaderMatch[1].trim();
    parsed.address = eip4361HeaderMatch[2].trim();

    const uriMatch = messageText.match(/URI:\s*([^\n\r]+)/i);
    if (uriMatch) parsed.uri = uriMatch[1].trim();

    const versionMatch = messageText.match(/Version:\s*([^\n\r]+)/i);
    if (versionMatch) parsed.version = versionMatch[1].trim();

    const chainIdMatch = messageText.match(/Chain ID:\s*(\d+)/i);
    if (chainIdMatch) parsed.chainId = parseInt(chainIdMatch[1], 10);

    const nonceMatch = messageText.match(/Nonce:\s*([a-zA-Z0-9]+)/i);
    if (nonceMatch) parsed.nonce = nonceMatch[1].trim();

    const issuedAtMatch = messageText.match(/Issued At:\s*([^\n\r]+)/i);
    if (issuedAtMatch) parsed.issuedAt = issuedAtMatch[1].trim();

    const expirationMatch = messageText.match(/Expiration Time:\s*([^\n\r]+)/i);
    if (expirationMatch) parsed.expirationTime = expirationMatch[1].trim();

    return parsed.domain ? parsed : null;
  }

  /**
   * Validates SIWE message parameters against expected authoritative configuration.
   */
  static validateMessage(
    messageText: string,
    expected: {
      domain: string;
      chainId?: number;
      nonce?: string;
      address?: string;
      uri?: string;
    }
  ): { valid: boolean; reason?: string } {
    const parsed = this.parseMessage(messageText);
    if (!parsed) {
      return { valid: false, reason: 'MALFORMED_SIWE_MESSAGE: Message does not conform to EIP-4361 specification.' };
    }

    // Domain validation (strip port if present, case-insensitive comparison)
    const cleanParsedDomain = parsed.domain.split(':')[0].toLowerCase();
    const cleanExpectedDomain = expected.domain.split(':')[0].toLowerCase();

    const isLocalhostMatch =
      (cleanExpectedDomain === 'localhost' || cleanExpectedDomain === '127.0.0.1') &&
      (cleanParsedDomain === 'localhost' || cleanParsedDomain === '127.0.0.1');

    if (cleanParsedDomain !== cleanExpectedDomain && !isLocalhostMatch) {
      return {
        valid: false,
        reason: `DOMAIN_MISMATCH: Message domain "${parsed.domain}" does not match authoritative domain "${expected.domain}".`,
      };
    }

    // URI validation (SEC-02: fail-closed if missing or mismatched)
    if (expected.uri) {
      if (!parsed.uri || parsed.uri !== expected.uri) {
        return {
          valid: false,
          reason: `URI_MISMATCH: Message URI "${parsed.uri || 'MISSING'}" does not match authoritative URI "${expected.uri}".`,
        };
      }
    }

    // Chain ID validation (SEC-03: fail-closed if missing or mismatched)
    if (expected.chainId !== undefined) {
      if (parsed.chainId === undefined || parsed.chainId !== expected.chainId) {
        return {
          valid: false,
          reason: `CHAIN_ID_MISMATCH: Message chain ID "${parsed.chainId !== undefined ? parsed.chainId : 'MISSING'}" does not match authoritative chain ID "${expected.chainId}".`,
        };
      }
    }

    // Nonce validation (fail-closed if missing or mismatched)
    if (expected.nonce) {
      if (!parsed.nonce || parsed.nonce !== expected.nonce) {
        return {
          valid: false,
          reason: `NONCE_MISMATCH: Message nonce does not match session nonce.`,
        };
      }
    }

    // Wallet address validation (SEC-03: fail-closed if missing or mismatched)
    if (expected.address) {
      if (!parsed.address) {
        return {
          valid: false,
          reason: `ADDRESS_MISMATCH: Message is missing required Ethereum account address.`,
        };
      }
      try {
        if (ethers.getAddress(parsed.address) !== ethers.getAddress(expected.address)) {
          return {
            valid: false,
            reason: `ADDRESS_MISMATCH: Message address "${parsed.address}" does not match claimed address "${expected.address}".`,
          };
        }
      } catch {
        return {
          valid: false,
          reason: `INVALID_ADDRESS: Message contains invalid Ethereum address "${parsed.address}".`,
        };
      }
    }

    // Expiration check
    if (parsed.expirationTime) {
      const expTimestamp = new Date(parsed.expirationTime).getTime();
      if (!isNaN(expTimestamp) && expTimestamp < Date.now()) {
        return {
          valid: false,
          reason: `EXPIRED_CHALLENGE: Challenge message expired at ${parsed.expirationTime}.`,
        };
      }
    }

    return { valid: true };
  }

  /**
   * Verifikasi ECDSA Signature SIWE dari Wallet User
   */
  static verifySignature(
    messageText: string,
    signature: string,
    expectedAddress: string
  ): boolean {
    try {
      const recoveredAddress = ethers.verifyMessage(messageText, signature);
      return ethers.getAddress(recoveredAddress) === ethers.getAddress(expectedAddress);
    } catch (err) {
      console.error('[SIWE Auth Error] Signature verification failed:', err);
      return false;
    }
  }
}
