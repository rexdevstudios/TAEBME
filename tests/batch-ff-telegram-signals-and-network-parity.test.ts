import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildOutboundWebhookRequest,
  formatTelegramSignalListReply,
} from '../packages/notifications/webhook-dispatcher';

const ROOT = path.resolve(import.meta.dir, '..');

describe('Phase FF: Neon networks Parity & Telegram /signals Growth Loop', () => {
  test('formatTelegramSignalListReply sorts by subscribersCount and builds /agent Apply Draft links', () => {
    const reply = formatTelegramSignalListReply({
      presets: [
        {
          id: 'p-low',
          title: 'Low Sub Preset',
          rail: 'CEX_AUTO',
          takeProfitPct: 12,
          stopLossPct: 4,
          trailingStopPct: 2,
          priceCredits: 50,
          subscribersCount: 2,
        },
        {
          id: 'p-high',
          title: 'Top KOL Scalper',
          rail: 'DEX_SESSION',
          takeProfitPct: 18,
          stopLossPct: 5,
          trailingStopPct: 3,
          priceCredits: 100,
          subscribersCount: 15,
        },
      ],
      siteOrigin: 'https://pndigi.site',
    });

    expect(reply.indexOf('Top KOL Scalper')).toBeLessThan(reply.indexOf('Low Sub Preset'));
    expect(reply).toContain('TP +18% / SL -5% / Trail 3%');
    expect(reply).toContain('https://pndigi.site/agent?tab=autopilot&presetId=p-high');

    const emptyReply = formatTelegramSignalListReply({ presets: [], siteOrigin: 'https://pndigi.site' });
    expect(emptyReply).toContain('No public signal presets published yet');
  });

  test('buildOutboundWebhookRequest formats SIGNAL_PRESET_PUBLISHED for Telegram channel broadcast', () => {
    const req = buildOutboundWebhookRequest(
      'https://api.telegram.org/bot123456:ABCDEF/sendMessage?chat_id=-10012345',
      {
        event: 'SIGNAL_PRESET_PUBLISHED',
        title: 'New Signal Strategy Preset: Base Alpha',
        message: 'TP +15% / SL -5%',
      },
      '2026-11-28T00:00:00.000Z'
    );
    expect(req.channel).toBe('TELEGRAM');
    expect(String(req.body.text)).toContain('New Signal Strategy Preset: Base Alpha');
  });

  test('wires /signals in telegram/webhook and SIGNAL_PRESET_PUBLISHED broadcast in agent/marketplace', () => {
    const tgSrc = fs.readFileSync(path.join(ROOT, 'app/api/telegram/webhook/route.ts'), 'utf8');
    const mktSrc = fs.readFileSync(path.join(ROOT, 'app/api/agent/marketplace/route.ts'), 'utf8');

    expect(tgSrc).toContain("cmd === '/signals' || cmd === '/presets'");
    expect(tgSrc).toContain('formatTelegramSignalListReply');
    expect(mktSrc).toContain('notifyPublicTelegramChannelBestEffort');
    expect(mktSrc).toContain("event: 'SIGNAL_PRESET_PUBLISHED'");
  });
});
