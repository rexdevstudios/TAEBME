/**
 * tests/batch-di-whitelabel-b2b-partner.test.ts
 *
 * Phase DI Verification Suite:
 *  - Verifies White-Label B2B partner input validation (slug, EVM treasury, 0..100 bps cap, Telegram chatId)
 *  - Verifies Telegram group chatId lookup and automatic white-label referral footer formatting
 *  - Verifies PostgresBillingDbAdapter CRUD persistence (in-memory fallback)
 */

import { describe, expect, test } from 'bun:test';
import {
  appendWhiteLabelTelegramFooter,
  resolvePartnerByTelegramChatId,
  validateWhiteLabelPartnerInput,
} from '../packages/billing/whitelabel-partner';
import { PostgresBillingDbAdapter } from '../packages/db/billing-repo';

describe('Phase DI: White-Label B2B Partner Config & Telegram /safety Tenanting', () => {
  test('[DI1.1] validates partner slug, EVM treasury, 0..100 bps cap, and Telegram chatId', () => {
    expect(
      validateWhiteLabelPartnerInput({
        slug: 'Bad Slug!',
        brandName: 'Alpha DAO',
        partnerFeeBps: 25,
        partnerTreasuryAddress: '0x1111111111111111111111111111111111111111',
      }).ok
    ).toBe(false);

    expect(
      validateWhiteLabelPartnerInput({
        slug: 'alpha-dao',
        brandName: 'Alpha DAO',
        partnerFeeBps: 150, // exceeds 100 bps hard cap
        partnerTreasuryAddress: '0x1111111111111111111111111111111111111111',
      }).ok
    ).toBe(false);

    const ok = validateWhiteLabelPartnerInput({
      slug: 'alpha-dao',
      brandName: 'Alpha DAO',
      partnerFeeBps: 50,
      partnerTreasuryAddress: '0x1111111111111111111111111111111111111111',
      telegramChatId: '-1001999888777',
    });
    expect(ok.ok).toBe(true);
    expect(ok.sanitized?.partnerFeeBps).toBe(50);
    expect(ok.sanitized?.telegramChatId).toBe('-1001999888777');
  });

  test('[DI1.2] resolves active partner by Telegram chatId and formats white-label footer', async () => {
    const repo = new PostgresBillingDbAdapter({
      getDbPool: () => null,
      ensureUserEntity: async (_p, u) => u,
    });

    const saved = await repo.upsertWhiteLabelPartner({
      slug: 'nusantara-dao',
      brandName: 'Nusantara Alpha',
      partnerFeeBps: 50,
      partnerTreasuryAddress: '0x2222222222222222222222222222222222222222',
      telegramChatId: '-1001234567890',
      active: true,
    });
    expect(saved.slug).toBe('nusantara-dao');

    const partners = await repo.getWhiteLabelPartners();
    const matched = resolvePartnerByTelegramChatId(partners, -1001234567890);
    expect(matched?.brandName).toBe('Nusantara Alpha');
    expect(resolvePartnerByTelegramChatId(partners, -1009999999999)).toBeNull();

    const reply = appendWhiteLabelTelegramFooter('Token SAFE (0% tax)', matched);
    expect(reply).toContain('Powered by Nusantara Alpha × POOLNET');
    expect(reply).toContain('partner=nusantara-dao&ref=0x2222222222222222222222222222222222222222');

    const deleted = await repo.deleteWhiteLabelPartner('nusantara-dao');
    expect(deleted).toBe(true);
    expect((await repo.getWhiteLabelPartners()).length).toBe(0);
  });
});
