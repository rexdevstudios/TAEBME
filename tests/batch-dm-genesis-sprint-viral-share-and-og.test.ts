/**
 * Unit Suite #80 — Phase DM:
 * POOLNET Genesis Sprint Viral Share Intents + Dynamic OpenGraph/Twitter Large-Image Card.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildGenesisShareIntents } from '../packages/billing/genesis-sbt';

describe('Phase DM — Genesis Sprint Viral Share Intents & OG Card', () => {
  test('buildGenesisShareIntents generates valid URL-encoded X and Telegram share intents', () => {
    const wallet = '0x1111111111111111111111111111111111111111';
    const intents = buildGenesisShareIntents('https://pndigi.site/', wallet, 42);

    expect(intents.referralUrl).toBe(`https://pndigi.site/?ref=${wallet}`);
    expect(intents.shareText).toContain('Genesis Pioneer #42');
    expect(intents.twitterIntentUrl).toContain('https://x.com/intent/tweet?');
    expect(intents.twitterIntentUrl).toContain(encodeURIComponent(intents.referralUrl));
    expect(intents.telegramShareUrl).toContain('https://t.me/share/url?');
    expect(intents.telegramShareUrl).toContain(encodeURIComponent(intents.referralUrl));
  });

  test('app/layout.tsx and app/opengraph-image.tsx expose POOLNET summary_large_image OG card', () => {
    const root = join(import.meta.dir, '..');
    const layoutSrc = readFileSync(join(root, 'app/layout.tsx'), 'utf8');
    expect(layoutSrc).toContain("metadataBase: new URL('https://pndigi.site')");
    expect(layoutSrc).toContain("siteName: 'POOLNET'");
    expect(layoutSrc).toContain("card: 'summary_large_image'");

    const ogSrc = readFileSync(join(root, 'app/opengraph-image.tsx'), 'utf8');
    expect(ogSrc).toContain('ImageResponse');
    expect(ogSrc).toContain('width: 1200');
    expect(ogSrc).toContain('height: 630');
    expect(ogSrc).toContain('POOLNET');

    const cardSrc = readFileSync(join(root, 'app/components/GenesisSbtCard.tsx'), 'utf8');
    expect(cardSrc).toContain('buildGenesisShareIntents');
    expect(cardSrc).toContain('Share on X');
    expect(cardSrc).toContain('Share on Telegram');
  });
});
