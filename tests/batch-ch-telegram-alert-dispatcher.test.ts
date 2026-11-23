import { describe, expect, it } from 'bun:test';
import {
  buildOutboundWebhookRequest,
  dispatchOutboundAlert,
  assertSafeWebhookUrl,
} from '../packages/notifications/webhook-dispatcher';

describe('Phase CH: Real-Time Telegram Alert Bot & Honeypot/Trailing-Stop Dispatcher', () => {
  it('CH1.1 formats Telegram Bot API sendMessage payload cleanly and strips query string from endpoint', () => {
    const req = buildOutboundWebhookRequest(
      'https://api.telegram.org/bot123456:ABC-DEF_xyz/sendMessage?chat_id=-10099887766',
      {
        event: 'TRAILING_STOP_TRIGGERED',
        title: 'Trailing Stop Executed SELL BTCUSDT (Bybit)',
        message: 'Harga turun 3% dari puncak ($115 -> $111.55)',
        metadata: {
          symbol: 'BTCUSDT',
          side: 'SELL',
          stage: 'LIVE',
        },
      },
      '2026-11-24T00:00:00.000Z'
    );

    expect(req.channel).toBe('TELEGRAM');
    expect(req.targetUrl).toBe('https://api.telegram.org/bot123456:ABC-DEF_xyz/sendMessage');
    expect(req.body.chat_id).toBe('-10099887766');
    expect(req.body.disable_web_page_preview).toBe(true);
    expect(String(req.body.text)).toContain('📉 [POOLNET · TRAILING_STOP_TRIGGERED]');
    expect(String(req.body.text)).toContain('Trailing Stop Executed SELL BTCUSDT (Bybit)');
    expect(String(req.body.text)).toContain('• symbol: BTCUSDT');
  });

  it('CH1.2 rejects Telegram sendMessage URL without chat_id query parameter', () => {
    expect(() =>
      buildOutboundWebhookRequest(
        'https://api.telegram.org/bot123456:ABC/sendMessage',
        {
          event: 'HONEYPOT_HARD_BLOCKED',
          title: 'Honeypot Blocked',
          message: 'Detected honeypot',
        },
        '2026-11-24T00:00:00.000Z'
      )
    ).toThrow(/INVALID_TELEGRAM_WEBHOOK_URL/);
  });

  it('CH1.3 dispatches HONEYPOT_HARD_BLOCKED alert via mocked Telegram API', async () => {
    let capturedUrl = '';
    let capturedBody: Record<string, unknown> = {};

    const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedBody = JSON.parse(String(init?.body || '{}'));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
    }) as typeof fetch;

    const res = await dispatchOutboundAlert({
      webhookUrl: 'https://api.telegram.org/bot999:SECRET/sendMessage?chat_id=12345',
      payload: {
        event: 'HONEYPOT_HARD_BLOCKED',
        title: 'Honeypot / Insider Guard Blocked SCAM',
        message: 'Token tidak bisa dijual (honeypot detected)',
        metadata: { symbol: 'SCAM', riskLevel: 'CRITICAL' },
      },
      fetchImpl: mockFetch,
    });

    expect(res.delivered).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(capturedUrl).toBe('https://api.telegram.org/bot999:SECRET/sendMessage');
    expect(capturedBody.chat_id).toBe('12345');
    expect(String(capturedBody.text)).toContain('🚨 [POOLNET · HONEYPOT_HARD_BLOCKED]');
  });

  it('CH1.4 preserves Discord and Generic HTTPS JSON payloads and SSRF protections', () => {
    const discordReq = buildOutboundWebhookRequest(
      'https://discord.com/api/webhooks/111/abc',
      { event: 'TOKEN_DEPLOYED', title: 'Deployed $MOON', message: 'Base L2 live' },
      '2026-11-24T00:00:00.000Z'
    );
    expect(discordReq.channel).toBe('DISCORD');
    expect(String(discordReq.body.content)).toContain('**[POOLNET · TOKEN_DEPLOYED] Deployed $MOON**');

    const genericReq = buildOutboundWebhookRequest(
      'https://hooks.example.com/rtrader',
      { event: 'ORDER_APPROVED', title: 'Order OK', message: 'Filled' },
      '2026-11-24T00:00:00.000Z'
    );
    expect(genericReq.channel).toBe('GENERIC');
    expect(genericReq.body.source).toBe('POOLNET_V25');

    expect(() => assertSafeWebhookUrl('http://api.telegram.org/bot123/sendMessage?chat_id=1')).toThrow(/UNSAFE_WEBHOOK_PROTOCOL/);
    expect(() => assertSafeWebhookUrl('https://169.254.169.254/latest/meta-data')).toThrow(/SSRF_BLOCKED_HOST/);
  });
});
