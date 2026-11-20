// ============================================================================
// GATE 2 — PNDIGI.SITE DOMAIN ALLOWLIST REGRESSION TEST SUITE
// ============================================================================
//
// Verifies the three entries added in Gate 1 (Phase 2.6.7):
//   - 'pndigi.site'          -> 'production'
//   - 'www.pndigi.site'      -> 'production'
//   - 'testnet.pndigi.site'  -> 'testnet'
//
// Tests:
//   POS-01 to POS-05: Positive acceptance tests
//   NEG-01 to NEG-05: Negative rejection tests
//
// Safety:
//   - All process.env mutations are isolated via beforeEach/afterEach snapshot.
//   - Test order independence guaranteed.
//   - No production source code is modified.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  validateAndResolveHost,
  getSiweConfig,
} from '../packages/shared/env-config';

describe('Gate 2 — pndigi.site Domain Allowlist Coverage', () => {
  // -------------------------------------------------------------------------
  // Environment isolation: snapshot + restore on every test
  // -------------------------------------------------------------------------
  const originalEnv = process.env;

  beforeEach(() => {
    // Fresh shallow copy — prevents cross-test state leakage
    process.env = { ...originalEnv };
    // Clear all env-resolver inputs to known state
    delete process.env.APP_ENV;
    delete process.env.NEXT_PUBLIC_APP_ENV;
    delete process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID;
    delete process.env.NEXT_PUBLIC_APP_URL;
  });

  afterEach(() => {
    // Unconditional restore
    process.env = originalEnv;
  });

  // =========================================================================
  // POSITIVE TESTS
  // =========================================================================

  describe('Positive Tests — Acceptance in Correct Environment', () => {

    it('POS-01: validates pndigi.site in production environment', () => {
      (process.env as Record<string, string>).NODE_ENV = 'production';
      process.env.APP_ENV = 'production';
      const result = validateAndResolveHost('pndigi.site');
      expect(result.domain).toBe('pndigi.site');
      expect(result.env).toBe('production');
    });

    it('POS-02: validates www.pndigi.site in production environment', () => {
      (process.env as Record<string, string>).NODE_ENV = 'production';
      process.env.APP_ENV = 'production';
      const result = validateAndResolveHost('www.pndigi.site');
      expect(result.domain).toBe('www.pndigi.site');
      expect(result.env).toBe('production');
    });

    it('POS-03: validates testnet.pndigi.site in testnet environment', () => {
      process.env.APP_ENV = 'testnet';
      const result = validateAndResolveHost('testnet.pndigi.site');
      expect(result.domain).toBe('testnet.pndigi.site');
      expect(result.env).toBe('testnet');
    });

    it('POS-04: getSiweConfig for pndigi.site returns production chain ID 8453', () => {
      (process.env as Record<string, string>).NODE_ENV = 'production';
      process.env.APP_ENV = 'production';
      const config = getSiweConfig('pndigi.site');
      expect(config.domain).toBe('pndigi.site');
      expect(config.chainId).toBe(8453);
      expect(config.uri).toMatch(/^https:\/\/pndigi\.site/);
    });

    it('POS-05: getSiweConfig for testnet.pndigi.site returns testnet chain ID 84532', () => {
      process.env.APP_ENV = 'testnet';
      const config = getSiweConfig('testnet.pndigi.site');
      expect(config.domain).toBe('testnet.pndigi.site');
      expect(config.chainId).toBe(84532);
      expect(config.uri).toMatch(/^https:\/\/testnet\.pndigi\.site/);
    });

  });

  // =========================================================================
  // NEGATIVE TESTS
  // =========================================================================

  describe('Negative Tests — Cross-Environment & Non-Allowlisted Rejection', () => {

    it('NEG-01: rejects pndigi.site (production host) in testnet environment (ENVIRONMENT_MISMATCH)', () => {
      process.env.APP_ENV = 'testnet';
      expect(() => validateAndResolveHost('pndigi.site'))
        .toThrow(/ENVIRONMENT_MISMATCH/);
    });

    it('NEG-02: rejects www.pndigi.site (production host) in testnet environment (ENVIRONMENT_MISMATCH)', () => {
      process.env.APP_ENV = 'testnet';
      expect(() => validateAndResolveHost('www.pndigi.site'))
        .toThrow(/ENVIRONMENT_MISMATCH/);
    });

    it('NEG-03: rejects testnet.pndigi.site (testnet host) in production environment (ENVIRONMENT_MISMATCH)', () => {
      (process.env as Record<string, string>).NODE_ENV = 'production';
      process.env.APP_ENV = 'production';
      expect(() => validateAndResolveHost('testnet.pndigi.site'))
        .toThrow(/ENVIRONMENT_MISMATCH/);
    });

    it('NEG-04: rejects app.pndigi.site — not in ALLOWED_DOMAINS (SECURITY_ERROR)', () => {
      (process.env as Record<string, string>).NODE_ENV = 'production';
      process.env.APP_ENV = 'production';
      expect(() => validateAndResolveHost('app.pndigi.site'))
        .toThrow(/SECURITY_ERROR/);
    });

    it('NEG-05: getSiweConfig rejects pndigi.site in testnet environment (ENVIRONMENT_MISMATCH)', () => {
      process.env.APP_ENV = 'testnet';
      expect(() => getSiweConfig('pndigi.site'))
        .toThrow(/ENVIRONMENT_MISMATCH/);
    });

  });

});
