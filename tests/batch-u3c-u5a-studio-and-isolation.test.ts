import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  TokenIdentitySchema,
  buildDeterministicFallbackIdentity,
  applyIdentityPrivacyShield,
  uploadLogoAndMetadataToIpfs,
  FALLBACK_LOGO_PNG_BUFFER,
} from '../packages/launchpad/creator-asset-studio';
import {
  generateSocialCardSvg,
  buildGrowthLaunchPack,
} from '../packages/launchpad/growth-launch-pack';

describe('Batch U3-C & U5-A — Creator Asset Studio, Growth Launch Pack & Vercel Isolation', () => {
  const root = process.cwd();

  it('buildDeterministicFallbackIdentity produces valid TokenIdentity passing Zod schema', () => {
    const id = buildDeterministicFallbackIdentity('Base AI Agents SocialFi Wave');
    const parsed = TokenIdentitySchema.safeParse(id);
    expect(parsed.success).toBe(true);
    expect(id.ticker).toMatch(/^[A-Z0-9]{2,10}$/);
  });

  it('applyIdentityPrivacyShield strips personal/placeholder handles', () => {
    const shielded = applyIdentityPrivacyShield({
      name: 'Alpha Coin',
      ticker: 'ALPHA',
      description: 'Community launchpad token on Base L2 with transparent bonding curve.',
      viralScore: 88,
      imagePrompt: 'futuristic glowing cyan coin badge minimalist',
      website: 'https://test.example.com',
      twitter: 'https://x.com/personal_account',
      telegram: 'https://t.me/random_group',
    });
    expect(shielded.website).toContain('pndigi.site');
    expect(shielded.twitter).toBe('https://x.com/ALPHA_coin');
    expect(shielded.telegram).toBe('https://t.me/alpha_portal');
  });

  it('uploadLogoAndMetadataToIpfs falls back cleanly to data URI when PINATA_JWT is absent', async () => {
    const prev = process.env.PINATA_JWT;
    delete process.env.PINATA_JWT;
    try {
      const id = buildDeterministicFallbackIdentity('Quantum Base');
      const res = await uploadLogoAndMetadataToIpfs(FALLBACK_LOGO_PNG_BUFFER, id);
      expect(res.uploadedToIpfs).toBe(false);
      expect(res.imageUrl.startsWith('data:image/png;base64,')).toBe(true);
      expect(res.metadataUrl).toBeNull();
    } finally {
      if (prev !== undefined) process.env.PINATA_JWT = prev;
    }
  });

  it('generateSocialCardSvg escapes XML/XSS payloads cleanly', () => {
    const svg = generateSocialCardSvg({
      name: '<script>alert(1)</script>',
      ticker: 'SAFE',
      contractAddress: '0x1111111111111111111111111111111111111111',
      chainDisplayName: 'Base',
    });
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('buildGrowthLaunchPack returns SVG, data URI, DexScreener, GeckoTerminal & Explorer URLs', () => {
    const pack = buildGrowthLaunchPack({
      chainId: 'base-mainnet',
      tokenAddress: '0x1234567890abcdef1234567890abcdef12345678',
      tokenName: 'Base Nova',
      tokenSymbol: '$NOVA',
    });
    expect(pack.socialCardDataUri.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(pack.dexScreener.chainId).toBe('base');
    expect(pack.dexScreener.updatePortalUrl).toContain('dexscreener.com/base/0x1234');
    expect(pack.geckoTerminal.network).toBe('base');
    expect(pack.geckoTerminal.tokenUrl).toContain('geckoterminal.com/base/tokens/0x1234');
    expect(pack.explorerUpdateUrl).toContain('basescan.org/tokenupdate/0x1234');
  });

  it('Vercel Control Plane isolation: .vercelignore and tsconfig.vercel.json exclude both src/ and apps/execution-plane/', () => {
    const vercelIgnore = readFileSync(join(root, '.vercelignore'), 'utf8');
    const tsconfigVercel = readFileSync(join(root, 'tsconfig.vercel.json'), 'utf8');
    expect(vercelIgnore).toContain('src/');
    expect(vercelIgnore).toContain('apps/execution-plane/');
    expect(tsconfigVercel).toContain('"apps/execution-plane"');
    expect(tsconfigVercel).not.toContain('"@apps/*"');
  });
});
