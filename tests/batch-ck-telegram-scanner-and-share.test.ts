import { describe, expect, it } from 'bun:test';
import {
  formatTelegramTokenSafetyReply,
  formatTelegramWalletRiskReply,
  buildSocialShareUrl,
} from '../packages/notifications/webhook-dispatcher';

describe('Phase CK: Telegram /safety & /wallet Scanner Formatters & Viral Share URL Builder', () => {
  it('CK1.1 formats HARD-BLOCKED honeypot token safety reply clearly for Telegram mobile', () => {
    const reply = formatTelegramTokenSafetyReply({
      address: '0x1111111111111111111111111111111111111111',
      chainId: 8453,
      riskLevel: 'CRITICAL',
      hardBlocked: true,
      isHoneypot: true,
      top10HolderPct: 88.5,
      suspectedClusterCount: 4,
      redFlags: ['HONEYPOT_DETECTED', 'INSIDER_CLUSTER_SUSPECTED'],
      summary: 'Token tidak dapat dijual (honeypot).',
    });

    expect(reply).toContain('🚨 HARD-BLOCKED');
    expect(reply).toContain('Chain 8453');
    expect(reply).toContain('Top-10 Holders: 88.5%');
    expect(reply).toContain('HONEYPOT_DETECTED');
  });

  it('CK1.2 formats TRUSTED and SANCTIONED wallet risk replies accurately', () => {
    const trusted = formatTelegramWalletRiskReply({
      walletAddress: '0x0000000000001ff3684f28c67538d4d072c22734',
      arkhamEntityName: '0x AllowanceHolder',
      arkhamEntityType: 'EXCHANGE',
      riskPassportScore: 95,
      isCounterpartyBlocked: false,
      tags: ['VERIFIED_PROTOCOL_ROUTER'],
    });
    expect(trusted).toContain('✅ TRUSTED');
    expect(trusted).toContain('95/100');
    expect(trusted).toContain('0x AllowanceHolder');

    const blocked = formatTelegramWalletRiskReply({
      walletAddress: '0x2222222222222222222222222222222222222222',
      arkhamEntityName: 'OFAC Sanctioned',
      arkhamEntityType: 'SANCTIONED',
      riskPassportScore: 0,
      isCounterpartyBlocked: true,
      tags: ['OFAC_SANCTIONED'],
    });
    expect(blocked).toContain('🚨 SANCTIONED / BLOCKED');
    expect(blocked).toContain('0/100');
  });

  it('CK1.3 builds URL-encoded X and Farcaster share URLs with valid EVM referral param only', () => {
    const xUrl = buildSocialShareUrl('x', {
      text: '🚀 $MOON live on POOLNET!',
      url: 'https://pndigi.site/token/base/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      refWallet: '0x0FB80514F29E336a35B2B3135C44b02B97F293a3',
    });
    expect(xUrl.startsWith('https://x.com/intent/tweet?')).toBe(true);
    expect(xUrl).toContain('ref%3D0x0FB80514F29E336a35B2B3135C44b02B97F293a3');

    const fcUrl = buildSocialShareUrl('farcaster', {
      text: 'Trade $MOON',
      url: 'https://pndigi.site/launchpad',
      refWallet: 'not-a-valid-wallet',
    });
    expect(fcUrl.startsWith('https://warpcast.com/~/compose?')).toBe(true);
    expect(fcUrl).not.toContain('not-a-valid-wallet');
  });
});
