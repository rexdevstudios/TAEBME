import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { formatTelegramAirdropListReply } from '../packages/notifications/webhook-dispatcher';

describe('Batch EV — Telegram /airdrop Command & Auto-Broadcast (Token Launch + Airdrop Campaign)', () => {
  const root = process.cwd();

  it('1. formatTelegramAirdropListReply lists active campaigns with direct /kol claim links and Genesis SBT info', () => {
    const reply = formatTelegramAirdropListReply({
      campaigns: [
        {
          id: 'camp-001',
          title: 'PUMPRUN Launch Airdrop',
          requiredHashtag: '#PUMPRUN',
          currentParticipants: 12,
          maxParticipants: 100,
          isActive: true,
        },
        {
          id: 'camp-inactive',
          title: 'Expired Campaign',
          isActive: false,
        },
      ],
      genesisMinted: 42,
      genesisCap: 1000,
      siteOrigin: 'https://pndigi.site',
    });

    expect(reply).toContain('PUMPRUN Launch Airdrop');
    expect(reply).toContain('#PUMPRUN');
    expect(reply).toContain('[12/100 slots]');
    expect(reply).toContain('https://pndigi.site/kol?campaignId=camp-001&tab=CLAIM');
    expect(reply).toContain('42/1000 minted');
    expect(reply).not.toContain('Expired Campaign');
  });

  it('2. formatTelegramAirdropListReply handles empty active campaign list gracefully', () => {
    const reply = formatTelegramAirdropListReply({ campaigns: [] });
    expect(reply).toContain('No active token bounty campaigns right now');
    expect(reply).toContain('https://pndigi.site/kol');
  });

  it('3. wires /airdrop in telegram webhook and public broadcast in bankr-deploy (!simulateOnly) & bounty POST', () => {
    const tgSrc = fs.readFileSync(path.join(root, 'app', 'api', 'telegram', 'webhook', 'route.ts'), 'utf8');
    const deploySrc = fs.readFileSync(path.join(root, 'app', 'api', 'launchpad', 'bankr-deploy', 'route.ts'), 'utf8');
    const bountySrc = fs.readFileSync(path.join(root, 'app', 'api', 'launchpad', 'bounty', 'route.ts'), 'utf8');

    expect(tgSrc).toContain("cmd === '/airdrop'");
    expect(tgSrc).toContain('formatTelegramAirdropListReply');
    expect(deploySrc).toContain('notifyPublicTelegramChannelBestEffort');
    expect(deploySrc).toContain("result.status === 'deployed' && !Boolean(body?.simulateOnly)");
    expect(bountySrc).toContain('notifyPublicTelegramChannelBestEffort');
    expect(bountySrc).toContain("event: 'AIRDROP_CAMPAIGN_CREATED'");
  });
});
