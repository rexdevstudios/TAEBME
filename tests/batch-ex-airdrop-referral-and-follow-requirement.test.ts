import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';
import {
  AIRDROP_REFERRAL_BONUS_CREDITS,
  buildAirdropReferralShareUrl,
  encodeRequiredFollowInDescription,
  normalizeFollowHandle,
  parseRequiredFollowFromDescription,
} from '../packages/shared/airdrop-referral';
import { formatTelegramAirdropListReply } from '../packages/notifications/webhook-dispatcher';

describe('Batch EX — Viral Airdrop Referral (?ref=0x...) & Required Follow (@handle)', () => {
  const root = process.cwd();

  it('1. normalizes, encodes, and parses required Follow @handle cleanly without DDL migration', () => {
    expect(normalizeFollowHandle('poolnet_xyz')).toBe('@poolnet_xyz');
    expect(normalizeFollowHandle('@@Base_KOL')).toBe('@Base_KOL');
    expect(normalizeFollowHandle('bad handle!')).toBeNull();

    const encoded = encodeRequiredFollowInDescription('Join our launch raid', 'poolnet_xyz');
    expect(encoded).toBe('[FOLLOW:@poolnet_xyz] Join our launch raid');
    expect(parseRequiredFollowFromDescription(encoded)).toBe('@poolnet_xyz');
  });

  it('2. builds valid campaign referral share URLs and omits invalid referrer addresses', () => {
    const valid = buildAirdropReferralShareUrl({
      campaignId: 'camp-42',
      referrerWallet: '0x0FB80514F29E330Cb1FF67058E8F2e1bFDeF93a3',
    });
    expect(valid).toBe(
      'https://pndigi.site/kol?campaignId=camp-42&tab=CLAIM&ref=0x0FB80514F29E330Cb1FF67058E8F2e1bFDeF93a3'
    );

    const noRef = buildAirdropReferralShareUrl({
      campaignId: 'camp-42',
      referrerWallet: 'invalid',
    });
    expect(noRef).toBe('https://pndigi.site/kol?campaignId=camp-42&tab=CLAIM');
    expect(AIRDROP_REFERRAL_BONUS_CREDITS).toBe(15);
  });

  it('3. Telegram /airdrop reply displays Follow @handle when present in description', () => {
    const reply = formatTelegramAirdropListReply({
      campaigns: [
        {
          id: 'camp-99',
          title: 'Genesis X Raid',
          requiredHashtag: '#POOLNET',
          description: '[FOLLOW:@poolnet_xyz] Raid campaign',
          currentParticipants: 3,
          maxParticipants: 50,
          isActive: true,
        },
      ],
    });
    expect(reply).toContain('Follow @poolnet_xyz');
  });

  it('4. wires idempotent referral bonus in bounty/claim and Copy Ref + Follow input in app/kol/page.tsx', () => {
    const claimSrc = fs.readFileSync(path.join(root, 'app', 'api', 'launchpad', 'bounty', 'claim', 'route.ts'), 'utf8');
    const kolSrc = fs.readFileSync(path.join(root, 'app', 'kol', 'page.tsx'), 'utf8');

    expect(claimSrc).toContain('normalizeReferrerWallet');
    expect(claimSrc).toContain('bounty_ref:${campaignId}:${result.claim.id}');
    expect(kolSrc).toContain('buildAirdropReferralShareUrl');
    expect(kolSrc).toContain('newFollowHandle');
  });
});
