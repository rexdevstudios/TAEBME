import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildOutboundWebhookRequest,
  buildTelegramInlineKeyboard,
} from '../packages/notifications/webhook-dispatcher';
import { buildMarketplaceDatasetAdvisorySummary } from '../packages/agent/signal-marketplace';

const ROOT = path.resolve(import.meta.dir, '..');

describe('Phase FH: Telegram Inline CTAs, Deep-Link Smooth Focus & Copilot Dataset Bridge', () => {
  test('buildTelegramInlineKeyboard accepts HTTPS-only URLs, drops unsafe protocols/private hosts, and chunks 2 per row', () => {
    const kb = buildTelegramInlineKeyboard([
      { text: 'Apply Strategy Draft →', url: 'https://pndigi.site/agent?tab=autopilot&presetId=p1' },
      { text: 'Unsafe JS', url: 'javascript:alert(1)' },
      { text: 'Localhost SSRF', url: 'https://localhost/admin' },
      { text: 'HTTP Plain', url: 'http://pndigi.site/kol' },
      { text: 'View Leaderboard', url: 'https://pndigi.site/leaderboard' },
      { text: 'Claim Airdrop', url: 'https://pndigi.site/kol?tab=CLAIM' },
    ]);

    expect(kb).toBeDefined();
    expect(kb!.inline_keyboard.length).toBe(2);
    expect(kb!.inline_keyboard[0].length).toBe(2);
    expect(kb!.inline_keyboard[1].length).toBe(1);
    expect(kb!.inline_keyboard[0][0].url).toBe('https://pndigi.site/agent?tab=autopilot&presetId=p1');
    expect(kb!.inline_keyboard[0][1].url).toBe('https://pndigi.site/leaderboard');
    expect(kb!.inline_keyboard[1][0].url).toBe('https://pndigi.site/kol?tab=CLAIM');

    expect(buildTelegramInlineKeyboard([])).toBeUndefined();
    expect(buildTelegramInlineKeyboard([{ text: 'Bad', url: 'http://127.0.0.1/x' }])).toBeUndefined();
  });

  test('buildOutboundWebhookRequest attaches reply_markup only for Telegram and stays backwards-compatible for Discord/Generic', () => {
    const payload = {
      event: 'SIGNAL_PRESET_PUBLISHED' as const,
      title: 'New Signal Strategy Preset: Base Alpha',
      message: 'TP +15% / SL -5%',
      buttons: [
        { text: 'Apply Strategy Draft →', url: 'https://pndigi.site/agent?tab=autopilot&presetId=p1' },
      ],
    };

    const tgReq = buildOutboundWebhookRequest(
      'https://api.telegram.org/bot123456:ABCDEF/sendMessage?chat_id=-10012345',
      payload,
      '2026-11-28T00:00:00.000Z'
    );
    expect(tgReq.channel).toBe('TELEGRAM');
    expect((tgReq.body.reply_markup as any)?.inline_keyboard?.[0]?.[0]?.text).toBe('Apply Strategy Draft →');

    const discordReq = buildOutboundWebhookRequest(
      'https://discord.com/api/webhooks/12345/abcdef',
      payload,
      '2026-11-28T00:00:00.000Z'
    );
    expect(discordReq.channel).toBe('DISCORD');
    expect(discordReq.body.reply_markup).toBeUndefined();
  });

  test('buildMarketplaceDatasetAdvisorySummary exposes topPresetId matching the highest-ranked KOL/subscriber preset', () => {
    const summary = buildMarketplaceDatasetAdvisorySummary([
      {
        id: 'preset-regular',
        title: 'Regular Momentum',
        description: 'Standard setup',
        creatorWallet: '0x1111111111111111111111111111111111111111',
        priceCredits: 50,
        rail: 'CEX_AUTO',
        takeProfitPct: 12,
        stopLossPct: 4,
        trailingStopPct: 2,
        allowedSymbols: ['ETHUSDT'],
        subscribersCount: 40,
        createdAt: '2026-11-28T00:00:00.000Z',
        kolVerified: false,
      },
      {
        id: 'preset-kol-top',
        title: 'KOL Base Alpha',
        description: 'Verified KOL setup',
        creatorWallet: '0x2222222222222222222222222222222222222222',
        priceCredits: 100,
        rail: 'DEX_SESSION',
        takeProfitPct: 20,
        stopLossPct: 5,
        trailingStopPct: 3,
        allowedSymbols: ['ETHUSDT'],
        subscribersCount: 8,
        createdAt: '2026-11-28T00:00:00.000Z',
        kolVerified: true,
      },
    ]);

    expect(summary).not.toBeNull();
    expect(summary!.topPresetId).toBe('preset-kol-top');
    expect(summary!.topPresetTitle).toBe('KOL Base Alpha');
  });

  test('wires inline keyboards, deep-link smooth focus, Copilot onFocusPreset bridge, and CI label hygiene', () => {
    const tgSrc = fs.readFileSync(path.join(ROOT, 'app/api/telegram/webhook/route.ts'), 'utf8');
    const mktRouteSrc = fs.readFileSync(path.join(ROOT, 'app/api/agent/marketplace/route.ts'), 'utf8');
    const bountyRouteSrc = fs.readFileSync(path.join(ROOT, 'app/api/launchpad/bounty/route.ts'), 'utf8');
    const bankrRouteSrc = fs.readFileSync(path.join(ROOT, 'app/api/launchpad/bankr-deploy/route.ts'), 'utf8');
    const copilotSrc = fs.readFileSync(path.join(ROOT, 'app/components/AiCopilotChatPanel.tsx'), 'utf8');
    const agentPageSrc = fs.readFileSync(path.join(ROOT, 'app/agent/page.tsx'), 'utf8');
    const mktPanelSrc = fs.readFileSync(path.join(ROOT, 'app/components/SignalMarketplacePanel.tsx'), 'utf8');
    const ciSrc = fs.readFileSync(path.join(ROOT, '.github/workflows/daily-dual-blackbox.yml'), 'utf8');

    expect(tgSrc).toContain('buildTelegramInlineKeyboard');
    expect(tgSrc).toContain('reply_markup');
    expect(mktRouteSrc).toContain('Apply Strategy Draft →');
    expect(bountyRouteSrc).toContain('Claim Airdrop →');
    expect(bankrRouteSrc).toContain('Explore Launchpad');
    expect(copilotSrc).toContain('onFocusPreset');
    expect(copilotSrc).toContain('topPresetId');
    expect(agentPageSrc).toContain('onFocusPreset={(pid) => setHighlightedPresetId(pid)}');
    expect(mktPanelSrc).toContain('scrollIntoView');
    expect(mktPanelSrc).toContain('SELECTED PRESET');
    expect(ciSrc).toMatch(/Testnet E2E \(5[2-9]\)/);
  });
});
