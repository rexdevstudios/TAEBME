// ============================================================================
// GAP-01: SIWE DOMAIN & CHAIN ID HARDCODING REMEDIATION TEST SUITE
// ============================================================================
//
// Verifies:
// 1. Production resolves domain `rbtrade.fun` and chainId `8453` (Base Mainnet).
// 2. Testnet resolves domain `testnet.rbtrade.fun` and chainId `84532` (Base Sepolia).
// 3. No legacy `rtrader.io` domain or hardcoded `8453` exists in testnet SIWE flow.
// 4. Strict fail-closed Host validation rejects untrusted hosts and environment mismatches.
// 5. Cryptographic EIP-4361 message parsing and validation prevents cross-domain / cross-chain replays.
// 6. API Route Handlers (/api/auth/challenge & /api/auth/verify) enforce environment invariants.
// 7. Nonces and session tokens are strictly namespaced and cryptographically isolated.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { ethers } from 'ethers';
import { NextRequest } from 'next/server';
import {
  getAppEnvironment,
  getEnvironmentConfig,
  getSiweConfig,
  validateAndResolveHost,
  formatRedisKey,
  validateChainAndContractConsistency,
} from '../packages/shared/env-config';
import { SiweAuthService } from '../packages/auth/siwe';
import { createSessionToken, verifySessionToken } from '../packages/auth/session';
import { POST as challengeHandler } from '../app/api/auth/challenge/route';
import { POST as verifyHandler } from '../app/api/auth/verify/route';
import { upstashRedis } from '../packages/shared/redis-client';
import { middleware } from '../middleware';

describe('GAP-01: SIWE Domain & Chain ID Hardcoding Remediation Suite', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('1. Authoritative Environment Configuration & SIWE Parameters', () => {
    it('resolves Base Mainnet configuration in production (domain: rbtrade.fun, chainId: 8453)', () => {
      process.env.APP_ENV = 'production';

      const env = getAppEnvironment();
      expect(env).toBe('production');

      const config = getEnvironmentConfig();
      expect(config.domain).toBe('rbtrade.fun');
      expect(config.chainId).toBe(8453);
      expect(config.chainHex).toBe('0x2105');
      expect(config.chainName).toBe('Base Mainnet');
      expect(config.canonicalUrl).toBe('https://rbtrade.fun');
      expect(config.redisPrefix).toBe('prod:');

      const siweConfig = getSiweConfig('rbtrade.fun');
      expect(siweConfig.domain).toBe('rbtrade.fun');
      expect(siweConfig.chainId).toBe(8453);
      expect(siweConfig.uri).toBe('https://rbtrade.fun/auth/login');
    });

    it('resolves Base Sepolia configuration in testnet (domain: testnet.rbtrade.fun, chainId: 84532)', () => {
      process.env.APP_ENV = 'testnet';

      const env = getAppEnvironment();
      expect(env).toBe('testnet');

      const config = getEnvironmentConfig();
      expect(config.domain).toBe('testnet.rbtrade.fun');
      expect(config.chainId).toBe(84532);
      expect(config.chainHex).toBe('0x14a34');
      expect(config.chainName).toBe('Base Sepolia Testnet');
      expect(config.canonicalUrl).toBe('https://testnet.rbtrade.fun');
      expect(config.redisPrefix).toBe('testnet:');

      const siweConfig = getSiweConfig('testnet.rbtrade.fun');
      expect(siweConfig.domain).toBe('testnet.rbtrade.fun');
      expect(siweConfig.chainId).toBe(84532);
      expect(siweConfig.uri).toBe('https://testnet.rbtrade.fun/auth/login');
    });

    it('confirms legacy rtrader.io is not the default in any environment', () => {
      for (const env of ['production', 'testnet', 'development', 'test'] as const) {
        process.env.APP_ENV = env;
        const siweConfig = getSiweConfig();
        expect(siweConfig.domain).not.toBe('rtrader.io');
        expect(siweConfig.uri).not.toContain('rtrader.io');
      }
    });
  });

  describe('2. Anti-Host-Poisoning & Fail-Closed Host Validation', () => {
    it('fails closed when host is an unknown external domain in production', () => {
      process.env.APP_ENV = 'production';
      expect(() => validateAndResolveHost('evil-hacker.com')).toThrow(/SECURITY_ERROR/);
      expect(() => validateAndResolveHost('rtrader.io')).toThrow(/SECURITY_ERROR/);
      expect(() => validateAndResolveHost('subdomain.rbtrade.fun.attacker.com')).toThrow(/SECURITY_ERROR/);
    });

    it('fails closed when host is an unknown external domain in testnet', () => {
      process.env.APP_ENV = 'testnet';
      expect(() => validateAndResolveHost('phishing.org')).toThrow(/SECURITY_ERROR/);
      expect(() => validateAndResolveHost('fake-testnet.fun')).toThrow(/SECURITY_ERROR/);
    });

    it('fails closed when production host is presented to testnet environment', () => {
      process.env.APP_ENV = 'testnet';
      expect(() => validateAndResolveHost('rbtrade.fun')).toThrow(/ENVIRONMENT_MISMATCH/);
    });

    it('fails closed when testnet host is presented to production environment', () => {
      process.env.APP_ENV = 'production';
      expect(() => validateAndResolveHost('testnet.rbtrade.fun')).toThrow(/ENVIRONMENT_MISMATCH/);
    });

    it('accepts localhost in development and test environments', () => {
      process.env.APP_ENV = 'development';
      const resDev = validateAndResolveHost('localhost:3000');
      expect(resDev.domain).toBe('localhost:3000');
      expect(resDev.env).toBe('development');

      process.env.APP_ENV = 'test';
      const resTest = validateAndResolveHost('127.0.0.1:3000');
      expect(resTest.domain).toBe('127.0.0.1:3000');
      expect(resTest.env).toBe('test');
    });

    it('accepts verified Vercel production domain and rejects unverified preview domains', () => {
      process.env.APP_ENV = 'production';
      const resVercel = validateAndResolveHost('rtrader-degen-platform.vercel.app');
      expect(resVercel.domain).toBe('rtrader-degen-platform.vercel.app');
      expect(resVercel.env).toBe('production');

      // Unverified preview domain must be rejected (fail-closed)
      expect(() => validateAndResolveHost('rtrader-degen-platform-abdulrochimx-5540s-projects.vercel.app')).toThrow(/SECURITY_ERROR/);
    });
  });

  describe('3. EIP-4361 SIWE Message Parsing & Strict Parameter Validation', () => {
    it('correctly generates and parses an EIP-4361 testnet challenge message', () => {
      process.env.APP_ENV = 'testnet';
      const wallet = ethers.Wallet.createRandom();

      const { challenge, messageText } = SiweAuthService.generateChallenge(
        'testnet.rbtrade.fun',
        wallet.address,
        'https://testnet.rbtrade.fun/auth/login',
        84532
      );

      expect(challenge.domain).toBe('testnet.rbtrade.fun');
      expect(challenge.chainId).toBe(84532);
      expect(challenge.address).toBe(wallet.address);

      const parsed = SiweAuthService.parseMessage(messageText);
      expect(parsed).not.toBeNull();
      expect(parsed?.domain).toBe('testnet.rbtrade.fun');
      expect(parsed?.chainId).toBe(84532);
      expect(parsed?.address?.toLowerCase()).toBe(wallet.address.toLowerCase());
      expect(parsed?.nonce).toBe(challenge.nonce);
      expect(parsed?.uri).toBe('https://testnet.rbtrade.fun/auth/login');
    });

    it('rejects SIWE message when domain does not match authoritative config', () => {
      process.env.APP_ENV = 'testnet';
      const wallet = ethers.Wallet.createRandom();

      // Attacker generated challenge for rbtrade.fun (mainnet) or rtrader.io
      const { messageText } = SiweAuthService.generateChallenge(
        'rtrader.io',
        wallet.address,
        'https://rtrader.io/auth/login',
        84532
      );

      const validation = SiweAuthService.validateMessage(messageText, {
        domain: 'testnet.rbtrade.fun',
        chainId: 84532,
        address: wallet.address,
      });

      expect(validation.valid).toBe(false);
      expect(validation.reason).toContain('DOMAIN_MISMATCH');
    });

    it('rejects SIWE message when chainId does not match authoritative config', () => {
      process.env.APP_ENV = 'testnet';
      const wallet = ethers.Wallet.createRandom();

      // Attacker generated challenge with Ethereum Mainnet chainId 1 or Base Mainnet 8453
      const { messageText } = SiweAuthService.generateChallenge(
        'testnet.rbtrade.fun',
        wallet.address,
        'https://testnet.rbtrade.fun/auth/login',
        8453 // Mainnet chain ID instead of Sepolia 84532
      );

      const validation = SiweAuthService.validateMessage(messageText, {
        domain: 'testnet.rbtrade.fun',
        chainId: 84532, // Expected testnet chain ID
        address: wallet.address,
      });

      expect(validation.valid).toBe(false);
      expect(validation.reason).toContain('CHAIN_ID_MISMATCH');
    });

    it('rejects SIWE message when wallet address does not match claimed address', () => {
      const walletA = ethers.Wallet.createRandom();
      const walletB = ethers.Wallet.createRandom();

      const { messageText } = SiweAuthService.generateChallenge(
        'testnet.rbtrade.fun',
        walletA.address,
        'https://testnet.rbtrade.fun/auth/login',
        84532
      );

      const validation = SiweAuthService.validateMessage(messageText, {
        domain: 'testnet.rbtrade.fun',
        chainId: 84532,
        address: walletB.address, // Mismatched claimed address
      });

      expect(validation.valid).toBe(false);
      expect(validation.reason).toContain('ADDRESS_MISMATCH');
    });

    it('rejects expired SIWE challenge message', () => {
      const wallet = ethers.Wallet.createRandom();
      const expiredTime = new Date(Date.now() - 60000).toISOString(); // 1 minute in the past

      const expiredMessage = `testnet.rbtrade.fun wants you to sign in with your Ethereum account:\n` +
        `${wallet.address}\n\n` +
        `Sign in to Degen Launchpad & Trading Terminal Platform\n\n` +
        `URI: https://testnet.rbtrade.fun/auth/login\n` +
        `Version: 1\n` +
        `Chain ID: 84532\n` +
        `Nonce: abc123nonce\n` +
        `Issued At: ${new Date(Date.now() - 120000).toISOString()}\n` +
        `Expiration Time: ${expiredTime}`;

      const validation = SiweAuthService.validateMessage(expiredMessage, {
        domain: 'testnet.rbtrade.fun',
        chainId: 84532,
        address: wallet.address,
      });

      expect(validation.valid).toBe(false);
      expect(validation.reason).toContain('EXPIRED_CHALLENGE');
    });

    it('rejects SIWE message when URI does not match authoritative URI', () => {
      const wallet = ethers.Wallet.createRandom();
      const { messageText } = SiweAuthService.generateChallenge(
        'testnet.rbtrade.fun',
        wallet.address,
        'https://attacker-phishing.fun/auth/login',
        84532
      );

      const validation = SiweAuthService.validateMessage(messageText, {
        domain: 'testnet.rbtrade.fun',
        chainId: 84532,
        address: wallet.address,
        uri: 'https://testnet.rbtrade.fun/auth/login',
      });

      expect(validation.valid).toBe(false);
      expect(validation.reason).toContain('URI_MISMATCH');
    });

    it('rejects SIWE message when nonce does not match session nonce', () => {
      const wallet = ethers.Wallet.createRandom();
      const { messageText } = SiweAuthService.generateChallenge(
        'testnet.rbtrade.fun',
        wallet.address,
        'https://testnet.rbtrade.fun/auth/login',
        84532
      );

      const validation = SiweAuthService.validateMessage(messageText, {
        domain: 'testnet.rbtrade.fun',
        chainId: 84532,
        address: wallet.address,
        nonce: 'different-expected-nonce-999',
      });

      expect(validation.valid).toBe(false);
      expect(validation.reason).toContain('NONCE_MISMATCH');
    });

    it('rejects SIWE message when URI is completely missing from message (SEC-02 fail-closed)', () => {
      const wallet = ethers.Wallet.createRandom();
      const { messageText } = SiweAuthService.generateChallenge(
        'testnet.rbtrade.fun',
        wallet.address,
        'https://testnet.rbtrade.fun/auth/login',
        84532
      );
      const msgWithoutUri = messageText.replace(/URI: [^\n]+\n/, '');

      const validation = SiweAuthService.validateMessage(msgWithoutUri, {
        domain: 'testnet.rbtrade.fun',
        chainId: 84532,
        address: wallet.address,
        uri: 'https://testnet.rbtrade.fun/auth/login',
      });

      expect(validation.valid).toBe(false);
      expect(validation.reason).toContain('URI_MISMATCH');
    });

    it('rejects SIWE message when Chain ID is missing from message (SEC-03)', () => {
      const wallet = ethers.Wallet.createRandom();
      const { messageText } = SiweAuthService.generateChallenge(
        'testnet.rbtrade.fun',
        wallet.address,
        'https://testnet.rbtrade.fun/auth/login',
        84532
      );
      const msgWithoutChain = messageText.replace(/Chain ID: [^\n]+\n/, '');

      const validation = SiweAuthService.validateMessage(msgWithoutChain, {
        domain: 'testnet.rbtrade.fun',
        chainId: 84532,
        address: wallet.address,
        uri: 'https://testnet.rbtrade.fun/auth/login',
      });

      expect(validation.valid).toBe(false);
      expect(validation.reason).toContain('CHAIN_ID_MISMATCH');
    });

    it('rejects simplified / non-standard format message that lacks standard EIP-4361 header (SEC-03)', () => {
      const simplifiedMsg = 'SIWE Authentication for testnet.rbtrade.fun\nNonce: abc123nonce\nURI: https://testnet.rbtrade.fun/auth/login';
      const validation = SiweAuthService.validateMessage(simplifiedMsg, {
        domain: 'testnet.rbtrade.fun',
        chainId: 84532,
        nonce: 'abc123nonce',
        uri: 'https://testnet.rbtrade.fun/auth/login',
      });

      expect(validation.valid).toBe(false);
      expect(validation.reason).toContain('MALFORMED_SIWE_MESSAGE');
    });
  });

  describe('4. End-to-End API Challenge & Verify Handlers', () => {
    it('POST /api/auth/challenge issues testnet challenge with testnet.rbtrade.fun & chain 84532', async () => {
      process.env.APP_ENV = 'testnet';
      const wallet = ethers.Wallet.createRandom();

      const req = new NextRequest('https://testnet.rbtrade.fun/api/auth/challenge', {
        method: 'POST',
        headers: {
          'host': 'testnet.rbtrade.fun',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ walletAddress: wallet.address }),
      });

      const res = await challengeHandler(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.nonce).toBeDefined();
      expect(json.data.messageToSign).toContain('testnet.rbtrade.fun wants you to sign in');
      expect(json.data.messageToSign).toContain('Chain ID: 84532');
      expect(json.data.messageToSign).toContain('URI: https://testnet.rbtrade.fun/auth/login');
      expect(json.data.messageToSign).not.toContain('rtrader.io');
    });

    it('POST /api/auth/challenge issues production challenge with rbtrade.fun & chain 8453', async () => {
      process.env.APP_ENV = 'production';
      const wallet = ethers.Wallet.createRandom();

      const req = new NextRequest('https://rbtrade.fun/api/auth/challenge', {
        method: 'POST',
        headers: {
          'host': 'rbtrade.fun',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ walletAddress: wallet.address }),
      });

      const res = await challengeHandler(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.messageToSign).toContain('rbtrade.fun wants you to sign in');
      expect(json.data.messageToSign).toContain('Chain ID: 8453');
      expect(json.data.messageToSign).toContain('URI: https://rbtrade.fun/auth/login');
      expect(json.data.messageToSign).not.toContain('rtrader.io');
    });

    it('POST /api/auth/verify succeeds for valid testnet signature and issues HMAC session token', async () => {
      process.env.APP_ENV = 'testnet';
      process.env.SESSION_SECRET = 'secure-testnet-session-secret-key-32bytes';
      const wallet = ethers.Wallet.createRandom();

      // 1. Challenge
      const challengeReq = new NextRequest('https://testnet.rbtrade.fun/api/auth/challenge', {
        method: 'POST',
        headers: { 'host': 'testnet.rbtrade.fun', 'content-type': 'application/json' },
        body: JSON.stringify({ walletAddress: wallet.address }),
      });
      const challengeRes = await challengeHandler(challengeReq);
      const challengeJson = await challengeRes.json();
      const { nonce, messageToSign } = challengeJson.data;

      // 2. Wallet Sign
      const signature = await wallet.signMessage(messageToSign);

      // 3. Verify
      const verifyReq = new NextRequest('https://testnet.rbtrade.fun/api/auth/verify', {
        method: 'POST',
        headers: { 'host': 'testnet.rbtrade.fun', 'content-type': 'application/json' },
        body: JSON.stringify({
          walletAddress: wallet.address,
          signature,
          nonce,
          message: messageToSign,
        }),
      });

      const verifyRes = await verifyHandler(verifyReq);
      expect(verifyRes.status).toBe(200);

      const verifyJson = await verifyRes.json();
      expect(verifyJson.success).toBe(true);
      expect(verifyJson.data.primaryWallet).toBe(wallet.address);
      expect(verifyJson.data.sessionToken).toBeDefined();

      // Confirm session token decodes and verifies with HMAC
      const decoded = verifySessionToken(verifyJson.data.sessionToken);
      expect(decoded).not.toBeNull();
      expect(decoded?.walletAddress.toLowerCase()).toBe(wallet.address.toLowerCase());
    });

    it('POST /api/auth/verify rejects request with missing body.message with 400 INVALID_INPUT (SEC-03)', async () => {
      process.env.APP_ENV = 'testnet';
      const wallet = ethers.Wallet.createRandom();

      const verifyReq = new NextRequest('https://testnet.rbtrade.fun/api/auth/verify', {
        method: 'POST',
        headers: { 'host': 'testnet.rbtrade.fun', 'content-type': 'application/json' },
        body: JSON.stringify({
          walletAddress: wallet.address,
          signature: '0x' + '11'.repeat(65),
          nonce: 'test-nonce-123',
          // message intentionally omitted
        }),
      });

      const verifyRes = await verifyHandler(verifyReq);
      expect(verifyRes.status).toBe(400);

      const verifyJson = await verifyRes.json();
      expect(verifyJson.success).toBe(false);
      expect(verifyJson.error.code).toBe('INVALID_INPUT');
      expect(verifyJson.error.message).toContain('message are required');
    });

    it('POST /api/auth/verify rejects message signed for a different domain (cross-domain replay)', async () => {
      process.env.APP_ENV = 'testnet';
      process.env.SESSION_SECRET = 'secure-testnet-session-secret-key-32bytes';
      const wallet = ethers.Wallet.createRandom();

      // Generate message for production domain rbtrade.fun
      const { challenge, messageText } = SiweAuthService.generateChallenge(
        'rbtrade.fun',
        wallet.address,
        'https://rbtrade.fun/auth/login',
        8453
      );
      const signature = await wallet.signMessage(messageText);

      // Submit to testnet verify endpoint
      const verifyReq = new NextRequest('https://testnet.rbtrade.fun/api/auth/verify', {
        method: 'POST',
        headers: { 'host': 'testnet.rbtrade.fun', 'content-type': 'application/json' },
        body: JSON.stringify({
          walletAddress: wallet.address,
          signature,
          nonce: challenge.nonce,
          message: messageText,
        }),
      });

      const verifyRes = await verifyHandler(verifyReq);
      expect(verifyRes.status).toBe(400);

      const verifyJson = await verifyRes.json();
      expect(verifyJson.success).toBe(false);
      expect(verifyJson.error.code).toBe('INVALID_SIWE_MESSAGE');
      expect(verifyJson.error.message).toContain('DOMAIN_MISMATCH');
    });

    it('POST /api/auth/verify rejects message signed with invalid chainId', async () => {
      process.env.APP_ENV = 'testnet';
      process.env.SESSION_SECRET = 'secure-testnet-session-secret-key-32bytes';
      const wallet = ethers.Wallet.createRandom();

      // Generate message for testnet domain but with wrong chainId (e.g. 1 instead of 84532)
      const { challenge, messageText } = SiweAuthService.generateChallenge(
        'testnet.rbtrade.fun',
        wallet.address,
        'https://testnet.rbtrade.fun/auth/login',
        1 // Wrong chain ID
      );
      const signature = await wallet.signMessage(messageText);

      const verifyReq = new NextRequest('https://testnet.rbtrade.fun/api/auth/verify', {
        method: 'POST',
        headers: { 'host': 'testnet.rbtrade.fun', 'content-type': 'application/json' },
        body: JSON.stringify({
          walletAddress: wallet.address,
          signature,
          nonce: challenge.nonce,
          message: messageText,
        }),
      });

      const verifyRes = await verifyHandler(verifyReq);
      expect(verifyRes.status).toBe(400);

      const verifyJson = await verifyRes.json();
      expect(verifyJson.success).toBe(false);
      expect(verifyJson.error.code).toBe('INVALID_SIWE_MESSAGE');
      expect(verifyJson.error.message).toContain('CHAIN_ID_MISMATCH');
    });

    it('POST /api/auth/verify rejects wallet mismatch with 401 WALLET_MISMATCH', async () => {
      process.env.APP_ENV = 'testnet';
      process.env.SESSION_SECRET = 'secure-testnet-session-secret-key-32bytes';
      const walletA = ethers.Wallet.createRandom(); // issued to
      const walletB = ethers.Wallet.createRandom(); // requesting

      const { challenge, messageText } = SiweAuthService.generateChallenge(
        'testnet.rbtrade.fun',
        walletB.address,
        'https://testnet.rbtrade.fun/auth/login',
        84532
      );
      const signature = await walletB.signMessage(messageText);

      const spyConfig = spyOn(upstashRedis, 'isConfigured').mockReturnValue(true);
      const spyGetdel = spyOn(upstashRedis, 'getdel').mockResolvedValue(walletA.address.toLowerCase());

      try {
        const verifyReq = new NextRequest('https://testnet.rbtrade.fun/api/auth/verify', {
          method: 'POST',
          headers: { 'host': 'testnet.rbtrade.fun', 'content-type': 'application/json' },
          body: JSON.stringify({
            walletAddress: walletB.address,
            signature,
            nonce: challenge.nonce,
            message: messageText,
          }),
        });

        const verifyRes = await verifyHandler(verifyReq);
        expect(verifyRes.status).toBe(401);

        const verifyJson = await verifyRes.json();
        expect(verifyJson.success).toBe(false);
        expect(verifyJson.error.code).toBe('WALLET_MISMATCH');
      } finally {
        spyConfig.mockRestore();
        spyGetdel.mockRestore();
      }
    });

    it('POST /api/auth/verify rejects consumed / nonexistent nonce with 401 INVALID_NONCE', async () => {
      process.env.APP_ENV = 'testnet';
      process.env.SESSION_SECRET = 'secure-testnet-session-secret-key-32bytes';
      const wallet = ethers.Wallet.createRandom();

      const { challenge, messageText } = SiweAuthService.generateChallenge(
        'testnet.rbtrade.fun',
        wallet.address,
        'https://testnet.rbtrade.fun/auth/login',
        84532
      );
      const signature = await wallet.signMessage(messageText);

      const spyConfig = spyOn(upstashRedis, 'isConfigured').mockReturnValue(true);
      const spyGetdel = spyOn(upstashRedis, 'getdel').mockResolvedValue(null);

      try {
        const verifyReq = new NextRequest('https://testnet.rbtrade.fun/api/auth/verify', {
          method: 'POST',
          headers: { 'host': 'testnet.rbtrade.fun', 'content-type': 'application/json' },
          body: JSON.stringify({
            walletAddress: wallet.address,
            signature,
            nonce: challenge.nonce,
            message: messageText,
          }),
        });

        const verifyRes = await verifyHandler(verifyReq);
        expect(verifyRes.status).toBe(401);

        const verifyJson = await verifyRes.json();
        expect(verifyJson.success).toBe(false);
        expect(verifyJson.error.code).toBe('INVALID_NONCE');
      } finally {
        spyConfig.mockRestore();
        spyGetdel.mockRestore();
      }
    });

    it('POST /api/auth/verify rejects invalid cryptographic signature with 401 INVALID_SIGNATURE', async () => {
      process.env.APP_ENV = 'testnet';
      process.env.SESSION_SECRET = 'secure-testnet-session-secret-key-32bytes';
      const wallet = ethers.Wallet.createRandom();
      const otherWallet = ethers.Wallet.createRandom();

      const { challenge, messageText } = SiweAuthService.generateChallenge(
        'testnet.rbtrade.fun',
        wallet.address,
        'https://testnet.rbtrade.fun/auth/login',
        84532
      );
      // Signed with different wallet private key
      const wrongSignature = await otherWallet.signMessage(messageText);

      const spyConfig = spyOn(upstashRedis, 'isConfigured').mockReturnValue(true);
      const spyGetdel = spyOn(upstashRedis, 'getdel').mockResolvedValue(wallet.address.toLowerCase());

      try {
        const verifyReq = new NextRequest('https://testnet.rbtrade.fun/api/auth/verify', {
          method: 'POST',
          headers: { 'host': 'testnet.rbtrade.fun', 'content-type': 'application/json' },
          body: JSON.stringify({
            walletAddress: wallet.address,
            signature: wrongSignature,
            nonce: challenge.nonce,
            message: messageText,
          }),
        });

        const verifyRes = await verifyHandler(verifyReq);
        expect(verifyRes.status).toBe(401);

        const verifyJson = await verifyRes.json();
        expect(verifyJson.success).toBe(false);
        expect(verifyJson.error.code).toBe('INVALID_SIGNATURE');
      } finally {
        spyConfig.mockRestore();
        spyGetdel.mockRestore();
      }
    });
  });

  describe('5. Cross-Environment Token Isolation & Redis Namespacing', () => {
    it('isolates Redis keys with testnet: and prod: prefixes', () => {
      process.env.APP_ENV = 'testnet';
      expect(formatRedisKey('siwe:nonce:0xabc')).toBe('testnet:siwe:nonce:0xabc');

      process.env.APP_ENV = 'production';
      expect(formatRedisKey('siwe:nonce:0xabc')).toBe('prod:siwe:nonce:0xabc');
    });

    it('rejects testnet-issued session tokens when verified in production environment', () => {
      process.env.SESSION_SECRET = 'cross-env-isolation-secret-32-chars';
      process.env.APP_ENV = 'testnet';

      const wallet = ethers.Wallet.createRandom();
      const token = createSessionToken({
        userId: 'usr-test-1',
        walletAddress: wallet.address,
      });

      // Valid in testnet
      expect(verifySessionToken(token)).not.toBeNull();

      // Invalid in production
      process.env.APP_ENV = 'production';
      expect(verifySessionToken(token)).toBeNull();
    });
  });

  describe('6. Edge Middleware Hardening & Public Path Protection', () => {
    it('allows GET /api/launchpad/graduate without session token', async () => {
      const req = new NextRequest('https://testnet.rbtrade.fun/api/launchpad/graduate', {
        method: 'GET',
        headers: { host: 'testnet.rbtrade.fun' },
      });

      const res = await middleware(req);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    });

    it('blocks POST /api/launchpad/graduate without session token with 401 UNAUTHORIZED', async () => {
      const req = new NextRequest('https://testnet.rbtrade.fun/api/launchpad/graduate', {
        method: 'POST',
        headers: { host: 'testnet.rbtrade.fun' },
      });

      const res = await middleware(req);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('UNAUTHORIZED');
    });

    it('allows POST /api/launchpad/graduate with valid 5-part session token', async () => {
      process.env.APP_ENV = 'testnet';
      process.env.SESSION_SECRET = 'secure-testnet-session-secret-key-32bytes';
      const wallet = ethers.Wallet.createRandom();
      const token = createSessionToken({
        userId: 'usr-grad-test',
        walletAddress: wallet.address,
      });

      const req = new NextRequest('https://testnet.rbtrade.fun/api/launchpad/graduate', {
        method: 'POST',
        headers: {
          host: 'testnet.rbtrade.fun',
          authorization: `Bearer ${token}`,
        },
      });

      const res = await middleware(req);
      expect(res.status).toBe(200);
    });

    it('blocks request with malformed session token (< 5 parts) with 401 UNAUTHORIZED', async () => {
      const malformedToken = Buffer.from('usr-123:0x1234:1234567890', 'utf8').toString('base64');
      const req = new NextRequest('https://testnet.rbtrade.fun/api/launchpad/graduate', {
        method: 'POST',
        headers: {
          host: 'testnet.rbtrade.fun',
          authorization: `Bearer ${malformedToken}`,
        },
      });

      const res = await middleware(req);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error.code).toBe('UNAUTHORIZED');
    });

    it('blocks request with expired session token (> 8 hours) with 401 UNAUTHORIZED', async () => {
      const expiredIssuedAt = (Date.now() - 9 * 60 * 60 * 1000).toString();
      const expiredToken = Buffer.from(`usr-123:0x1234567890123456789012345678901234567890:${expiredIssuedAt}:nonce123:sig123`, 'utf8').toString('base64');

      const req = new NextRequest('https://testnet.rbtrade.fun/api/launchpad/graduate', {
        method: 'POST',
        headers: {
          host: 'testnet.rbtrade.fun',
          authorization: `Bearer ${expiredToken}`,
        },
      });

      const res = await middleware(req);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error.code).toBe('UNAUTHORIZED');
    });

    it('blocks request when session token has fabricated HMAC signature (SEC-01)', async () => {
      process.env.APP_ENV = 'testnet';
      process.env.SESSION_SECRET = 'secure-testnet-session-secret-key-32bytes';
      const wallet = ethers.Wallet.createRandom();
      const fakeSig = '00'.repeat(32);
      const fakeToken = Buffer.from(
        `usr-test:${wallet.address}:${Date.now()}:nonce123:${fakeSig}`,
        'utf8'
      ).toString('base64');

      const req = new NextRequest('https://testnet.rbtrade.fun/api/launchpad/graduate', {
        method: 'POST',
        headers: {
          host: 'testnet.rbtrade.fun',
          authorization: `Bearer ${fakeToken}`,
        },
      });

      const res = await middleware(req);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error.code).toBe('UNAUTHORIZED');
    });

    it('blocks request when session token payload is tampered (wallet address changed) (SEC-01)', async () => {
      process.env.APP_ENV = 'testnet';
      process.env.SESSION_SECRET = 'secure-testnet-session-secret-key-32bytes';
      const legitWallet = ethers.Wallet.createRandom();
      const attackerWallet = ethers.Wallet.createRandom();
      const legitToken = createSessionToken({
        userId: 'usr-legit',
        walletAddress: legitWallet.address,
      });

      const decoded = Buffer.from(legitToken, 'base64').toString('utf8');
      const parts = decoded.split(':');
      parts[1] = attackerWallet.address;
      const tamperedToken = Buffer.from(parts.join(':'), 'utf8').toString('base64');

      const req = new NextRequest('https://testnet.rbtrade.fun/api/launchpad/graduate', {
        method: 'POST',
        headers: {
          host: 'testnet.rbtrade.fun',
          authorization: `Bearer ${tamperedToken}`,
        },
      });

      const res = await middleware(req);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error.code).toBe('UNAUTHORIZED');
    });

    it('blocks request when session token payload is tampered (userId changed) (SEC-01)', async () => {
      process.env.APP_ENV = 'testnet';
      process.env.SESSION_SECRET = 'secure-testnet-session-secret-key-32bytes';
      const legitWallet = ethers.Wallet.createRandom();
      const legitToken = createSessionToken({
        userId: 'usr-legit',
        walletAddress: legitWallet.address,
      });

      const decoded = Buffer.from(legitToken, 'base64').toString('utf8');
      const parts = decoded.split(':');
      parts[0] = 'usr-admin-priv';
      const tamperedToken = Buffer.from(parts.join(':'), 'utf8').toString('base64');

      const req = new NextRequest('https://testnet.rbtrade.fun/api/launchpad/graduate', {
        method: 'POST',
        headers: {
          host: 'testnet.rbtrade.fun',
          authorization: `Bearer ${tamperedToken}`,
        },
      });

      const res = await middleware(req);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error.code).toBe('UNAUTHORIZED');
    });

    it('blocks request when session token is signed with a different environment secret (cross-env token replay) (SEC-01)', async () => {
      process.env.APP_ENV = 'testnet';
      process.env.SESSION_SECRET = 'secure-session-secret-key-32bytes';
      const wallet = ethers.Wallet.createRandom();
      const testnetToken = createSessionToken({
        userId: 'usr-cross-env',
        walletAddress: wallet.address,
      });

      process.env.APP_ENV = 'production';
      const req = new NextRequest('https://rbtrade.fun/api/launchpad/graduate', {
        method: 'POST',
        headers: {
          host: 'rbtrade.fun',
          authorization: `Bearer ${testnetToken}`,
        },
      });

      const res = await middleware(req);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error.code).toBe('UNAUTHORIZED');
    });

    it('enforces fail-closed when session secret is missing or whitespace-only in production or testnet environment', () => {
      const origSecret = process.env.SESSION_SECRET;
      const origVault = process.env.MASTER_VAULT_KEY;
      const origAppEnv = process.env.APP_ENV;
      const origNodeEnv = process.env.NODE_ENV;

      try {
        // 1. Missing in production NODE_ENV without APP_ENV
        process.env.NODE_ENV = 'production';
        delete process.env.APP_ENV;
        delete process.env.SESSION_SECRET;
        delete process.env.MASTER_VAULT_KEY;
        expect(() => {
          createSessionToken({ userId: 'u1', walletAddress: '0x1234567890123456789012345678901234567890' });
        }).toThrow(/FATAL_CONFIG_ERROR/);

        // 2. Whitespace-only in production
        process.env.SESSION_SECRET = '   ';
        process.env.MASTER_VAULT_KEY = ' \t ';
        expect(() => {
          createSessionToken({ userId: 'u1', walletAddress: '0x1234567890123456789012345678901234567890' });
        }).toThrow(/FATAL_CONFIG_ERROR/);

        // 3. Missing in testnet APP_ENV
        process.env.NODE_ENV = 'development';
        process.env.APP_ENV = 'testnet';
        delete process.env.SESSION_SECRET;
        delete process.env.MASTER_VAULT_KEY;
        expect(() => {
          createSessionToken({ userId: 'u1', walletAddress: '0x1234567890123456789012345678901234567890' });
        }).toThrow(/FATAL_CONFIG_ERROR/);

        // 4. Whitespace-only in testnet
        process.env.SESSION_SECRET = '   ';
        expect(() => {
          createSessionToken({ userId: 'u1', walletAddress: '0x1234567890123456789012345678901234567890' });
        }).toThrow(/FATAL_CONFIG_ERROR/);
      } finally {
        if (origSecret !== undefined) process.env.SESSION_SECRET = origSecret; else delete process.env.SESSION_SECRET;
        if (origVault !== undefined) process.env.MASTER_VAULT_KEY = origVault; else delete process.env.MASTER_VAULT_KEY;
        if (origAppEnv !== undefined) process.env.APP_ENV = origAppEnv; else delete process.env.APP_ENV;
        if (origNodeEnv !== undefined) process.env.NODE_ENV = origNodeEnv; else delete process.env.NODE_ENV;
      }
    });

    it('enforces minimum 32 characters for session secret in production and testnet environments', () => {
      const origSecret = process.env.SESSION_SECRET;
      const origVault = process.env.MASTER_VAULT_KEY;
      const origAppEnv = process.env.APP_ENV;
      const origNodeEnv = process.env.NODE_ENV;

      delete process.env.MASTER_VAULT_KEY;

      try {
        // Short secret (< 32 chars) in production
        process.env.NODE_ENV = 'production';
        delete process.env.APP_ENV;
        process.env.SESSION_SECRET = 'short-secret-less-than-32-chars';
        expect(() => {
          createSessionToken({ userId: 'u1', walletAddress: '0x1234567890123456789012345678901234567890' });
        }).toThrow(/at least 32 characters/);

        // Short secret (< 32 chars) in testnet
        process.env.NODE_ENV = 'development';
        process.env.APP_ENV = 'testnet';
        process.env.SESSION_SECRET = 'tiny-key-16bytes!';
        expect(() => {
          createSessionToken({ userId: 'u1', walletAddress: '0x1234567890123456789012345678901234567890' });
        }).toThrow(/at least 32 characters/);

        // Valid secret (>= 32 chars) succeeds
        process.env.SESSION_SECRET = 'valid-production-secret-must-be-at-least-32-chars';
        const token = createSessionToken({ userId: 'u1', walletAddress: '0x1234567890123456789012345678901234567890' });
        expect(token).toBeDefined();
        expect(typeof token).toBe('string');
      } finally {
        if (origSecret !== undefined) process.env.SESSION_SECRET = origSecret; else delete process.env.SESSION_SECRET;
        if (origVault !== undefined) process.env.MASTER_VAULT_KEY = origVault; else delete process.env.MASTER_VAULT_KEY;
        if (origAppEnv !== undefined) process.env.APP_ENV = origAppEnv; else delete process.env.APP_ENV;
        if (origNodeEnv !== undefined) process.env.NODE_ENV = origNodeEnv; else delete process.env.NODE_ENV;
      }
    });

    it('ensures whitespace-only MASTER_VAULT_KEY does not shadow valid SESSION_SECRET', () => {
      const origSecret = process.env.SESSION_SECRET;
      const origVault = process.env.MASTER_VAULT_KEY;
      const origAppEnv = process.env.APP_ENV;
      const origNodeEnv = process.env.NODE_ENV;

      try {
        process.env.NODE_ENV = 'production';
        process.env.APP_ENV = 'production';
        process.env.MASTER_VAULT_KEY = '   \t  \n  ';
        process.env.SESSION_SECRET = 'valid-session-secret-that-is-at-least-32-characters-long';

        const token = createSessionToken({ userId: 'u1', walletAddress: '0x1234567890123456789012345678901234567890' });
        expect(token).toBeDefined();

        const verified = verifySessionToken(token);
        expect(verified).not.toBeNull();
        expect(verified?.userId).toBe('u1');
      } finally {
        if (origSecret !== undefined) process.env.SESSION_SECRET = origSecret; else delete process.env.SESSION_SECRET;
        if (origVault !== undefined) process.env.MASTER_VAULT_KEY = origVault; else delete process.env.MASTER_VAULT_KEY;
        if (origAppEnv !== undefined) process.env.APP_ENV = origAppEnv; else delete process.env.APP_ENV;
        if (origNodeEnv !== undefined) process.env.NODE_ENV = origNodeEnv; else delete process.env.NODE_ENV;
      }
    });

    it('verifies Edge middleware and session module enforce consistent fail-closed secret policies', async () => {
      const origSecret = process.env.SESSION_SECRET;
      const origVault = process.env.MASTER_VAULT_KEY;
      const origAppEnv = process.env.APP_ENV;
      const origNodeEnv = process.env.NODE_ENV;

      try {
        process.env.NODE_ENV = 'production';
        process.env.APP_ENV = 'production';
        // Short secret (< 32 chars)
        process.env.SESSION_SECRET = 'too-short-secret';
        delete process.env.MASTER_VAULT_KEY;

        // Session module throws FATAL_CONFIG_ERROR when attempting to issue or resolve tokens with short secret
        expect(() => {
          createSessionToken({ userId: 'u1', walletAddress: '0x1234567890123456789012345678901234567890' });
        }).toThrow(/at least 32 characters/);

        // verifySessionToken returns null (fails closed) when secret is misconfigured
        const sessionResult = verifySessionToken('validlookingtokenformatpart123456789012345');
        expect(sessionResult).toBeNull();

        // Edge Middleware fails closed and returns 401 UNAUTHORIZED
        const req = new NextRequest('https://rbtrade.fun/api/launchpad/graduate', {
          method: 'POST',
          headers: {
            host: 'rbtrade.fun',
            authorization: 'Bearer dXNyLTE6MHgxMjM0NTY3ODkwMTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwOjE3MjkxMjM0NTY3ODk6bm9uY2UxMjM6c2lnbmF0dXJl',
          },
        });

        const res = await middleware(req);
        expect(res.status).toBe(401);
        const json = await res.json();
        expect(json.success).toBe(false);
        expect(json.error.code).toBe('UNAUTHORIZED');
      } finally {
        if (origSecret !== undefined) process.env.SESSION_SECRET = origSecret; else delete process.env.SESSION_SECRET;
        if (origVault !== undefined) process.env.MASTER_VAULT_KEY = origVault; else delete process.env.MASTER_VAULT_KEY;
        if (origAppEnv !== undefined) process.env.APP_ENV = origAppEnv; else delete process.env.APP_ENV;
        if (origNodeEnv !== undefined) process.env.NODE_ENV = origNodeEnv; else delete process.env.NODE_ENV;
      }
    });
  });
});
