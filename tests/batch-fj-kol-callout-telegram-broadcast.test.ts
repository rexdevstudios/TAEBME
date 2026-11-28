import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { buildOutboundWebhookRequest } from '../packages/notifications/webhook-dispatcher';

const ROOT = path.resolve(import.meta.dir, '..');

describe('Phase FJ: Verified KOL Callout Telegram Broadcast & Live E2E Coverage', () => {
  test('buildOutboundWebhookRequest formats KOL_CALLOUT_PINNED with Telegram inline keyboard CTAs', () => {
    const req = buildOutboundWebhookRequest(
      'https://api.telegram.org/bot123456:ABCDEF/sendMessage?chat_id=-10012345',
      {
        event: 'KOL_CALLOUT_PINNED',
        title: '@hydra21 (GOLD KOL) pinned BUY Callout on $HSET',
        message: '"Strong Base bonding curve traction."',
        buttons: [
          { text: 'Inspect Chart & Callout →', url: 'https://pndigi.site/token/base/0x2c94879c2b482d1838ccce3cd00ffd96a82fbcb8' },
          { text: 'View Tweet →', url: 'https://x.com/hydra21/status/123456' },
        ],
      },
      '2026-11-28T00:00:00.000Z'
    );

    expect(req.channel).toBe('TELEGRAM');
    expect(String(req.body.text)).toContain('KOL_CALLOUT_PINNED');
    expect(String(req.body.text)).toContain('@hydra21');
    const kb = (req.body.reply_markup as any)?.inline_keyboard;
    expect(Array.isArray(kb)).toBe(true);
    expect(kb[0].length).toBe(2);
    expect(kb[0][0].text).toBe('Inspect Chart & Callout →');
    expect(kb[0][1].url).toBe('https://x.com/hydra21/status/123456');
  });

  test('wires KOL_CALLOUT_PINNED broadcast in /api/kol/callout, E2E assertions in testnet suite & CI label', () => {
    const calloutSrc = fs.readFileSync(path.join(ROOT, 'app/api/kol/callout/route.ts'), 'utf8');
    const e2eSrc = fs.readFileSync(path.join(ROOT, 'scripts/test-testnet-full-usecase.ts'), 'utf8');
    const ciSrc = fs.readFileSync(path.join(ROOT, '.github/workflows/daily-dual-blackbox.yml'), 'utf8');

    expect(calloutSrc).toContain('notifyPublicTelegramChannelBestEffort');
    expect(calloutSrc).toContain("event: 'KOL_CALLOUT_PINNED'");
    expect(calloutSrc).toContain('Inspect Chart & Callout →');
    expect(e2eSrc).toContain('/api/kol/callout');
    expect(e2eSrc).toContain('KOL_VERIFICATION_REQUIRED');
    expect(ciSrc).toContain('Testnet E2E (54)');
  });
});
