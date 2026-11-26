import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  AIRDROP_REFERRAL_BONUS_CREDITS,
  AIRDROP_REFERRAL_REFERENCE_PREFIX,
  buildAirdropReferralReferenceId,
  parseAirdropReferralReferenceId,
  summarizeAirdropReferralLedger,
} from '../packages/shared/airdrop-referral';

const ROOT = path.resolve(import.meta.dir, '..');

describe('Phase EY: My Referral Stats API, /kol Passport UI & E2E Simulation', () => {
  test('buildAirdropReferralReferenceId & parseAirdropReferralReferenceId round-trip cleanly', () => {
    const refId = buildAirdropReferralReferenceId('campaign-123', 'claim-456');
    expect(refId).toBe(`${AIRDROP_REFERRAL_REFERENCE_PREFIX}campaign-123:claim-456`);
    expect(parseAirdropReferralReferenceId(refId)).toEqual({
      campaignId: 'campaign-123',
      claimId: 'claim-456',
    });
    expect(parseAirdropReferralReferenceId('other_prefix:a:b')).toBeNull();
    expect(parseAirdropReferralReferenceId('bounty_ref:onlyonepart')).toBeNull();
    expect(parseAirdropReferralReferenceId(null)).toBeNull();
  });

  test('summarizeAirdropReferralLedger filters non-referral rows, deduplicates referenceId, and sorts newest first', () => {
    const summary = summarizeAirdropReferralLedger([
      {
        id: 'e1',
        amount: AIRDROP_REFERRAL_BONUS_CREDITS,
        currency: 'CREDITS',
        type: 'CREDIT',
        referenceId: 'bounty_ref:camp-1:claim-a',
        createdAt: '2026-11-26T09:00:00.000Z',
      },
      {
        id: 'e1-duplicate',
        amount: AIRDROP_REFERRAL_BONUS_CREDITS,
        currency: 'CREDITS',
        type: 'CREDIT',
        referenceId: 'bounty_ref:camp-1:claim-a',
        createdAt: '2026-11-26T09:05:00.000Z',
      },
      {
        id: 'e2',
        amount: AIRDROP_REFERRAL_BONUS_CREDITS,
        currency: 'CREDITS',
        type: 'CREDIT',
        referenceId: 'bounty_ref:camp-2:claim-b',
        createdAt: '2026-11-26T10:30:00.000Z',
      },
      {
        id: 'e3-debit',
        amount: 15,
        currency: 'CREDITS',
        type: 'DEBIT',
        referenceId: 'bounty_ref:camp-3:claim-c',
        createdAt: '2026-11-26T11:00:00.000Z',
      },
      {
        id: 'e4-other',
        amount: 50,
        currency: 'CREDITS',
        type: 'CREDIT',
        referenceId: 'plan_upgrade:pro',
        createdAt: '2026-11-26T12:00:00.000Z',
      },
    ]);

    expect(summary.totalReferrals).toBe(2);
    expect(summary.totalCreditsEarned).toBe(30);
    expect(summary.bonusPerReferral).toBe(15);
    expect(summary.recentReferrals).toHaveLength(2);
    expect(summary.recentReferrals[0].claimId).toBe('claim-b');
    expect(summary.recentReferrals[1].claimId).toBe('claim-a');
  });

  test('app/api/launchpad/bounty/referrals/route.ts enforces fail-closed requireActiveSession and indexed ledger query', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'app/api/launchpad/bounty/referrals/route.ts'),
      'utf8'
    );
    expect(src).toContain("export const dynamic = 'force-dynamic'");
    expect(src).toContain('requireActiveSession(req)');
    expect(src).toContain('status: isForbidden ? 403 : 401');
    expect(src).toContain('FROM ledger_entries');
    expect(src).toContain('WHERE user_id = $1::uuid');
    expect(src).toContain('reference_id LIKE $2');
  });

  test('app/api/launchpad/bounty/claim/route.ts reuses buildAirdropReferralReferenceId SSOT helper', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'app/api/launchpad/bounty/claim/route.ts'),
      'utf8'
    );
    expect(src).toContain('buildAirdropReferralReferenceId');
    expect(src).toContain('buildAirdropReferralReferenceId(campaignId, result.claim.id)');
  });

  test('app/kol/page.tsx wires /api/launchpad/bounty/referrals and renders tri-language My Referral Stats', () => {
    const src = fs.readFileSync(path.join(ROOT, 'app/kol/page.tsx'), 'utf8');
    expect(src).toContain('/api/launchpad/bounty/referrals');
    expect(src).toContain('My Referral Stats');
    expect(src).toContain('Statistik Referral Saya');
    expect(src).toContain('我的邀请统计');
    expect(src).toContain('referralStats.totalReferrals');
    expect(src).toContain('referralStats.totalCreditsEarned');
  });
});
