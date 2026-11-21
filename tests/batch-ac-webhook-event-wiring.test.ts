import { describe, it, expect } from 'bun:test';
import { notifyUserWebhookBestEffort } from '../packages/notifications/webhook-dispatcher';

describe('Phase AC: Live Outbound Webhook Event Wiring (Non-Blocking & SSRF-Safe)', () => {
  it('[AC1.1] notifyUserWebhookBestEffort is a clean zero-network no-op when user has no webhook configured', async () => {
    let fetchCalled = false;
    const res = await notifyUserWebhookBestEffort({
      resolveWebhookUrl: async () => null,
      payload: {
        event: 'ORDER_APPROVED',
        title: 'Order Approved: BUY BTCUSDT',
        message: 'Qty 0.1 BTCUSDT approved by Risk Gate',
      },
      fetchImpl: (async () => {
        fetchCalled = true;
        return new Response('ok', { status: 200 });
      }) as typeof fetch,
    });

    expect(res.attempted).toBe(false);
    expect(res.delivered).toBe(false);
    expect(fetchCalled).toBe(false);
  });

  it('[AC1.2] notifyUserWebhookBestEffort dispatches ORDER_APPROVED, DAILY_LOSS_WARNING, and TOKEN_DEPLOYED cleanly', async () => {
    const sentPayloads: any[] = [];
    const mockFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      sentPayloads.push(JSON.parse(String(init?.body || '{}')));
      return new Response('ok', { status: 204 });
    }) as typeof fetch;

    const r1 = await notifyUserWebhookBestEffort({
      resolveWebhookUrl: async () => 'https://discord.com/api/webhooks/123456/token-abc',
      payload: {
        event: 'ORDER_APPROVED',
        title: 'Order Approved: BUY ETHUSDT',
        message: 'Mode CEX_SINGLE_SHOT · Qty 1.5 ETHUSDT',
        metadata: { symbol: 'ETHUSDT', side: 'BUY', executionMode: 'CEX_SINGLE_SHOT' },
      },
      fetchImpl: mockFetch,
    });
    expect(r1.attempted).toBe(true);
    expect(r1.delivered).toBe(true);
    expect(sentPayloads[0].content).toContain('[POOLNET · ORDER_APPROVED]');

    const r2 = await notifyUserWebhookBestEffort({
      resolveWebhookUrl: async () => 'https://hooks.example.com/alerts',
      payload: {
        event: 'DAILY_LOSS_WARNING',
        title: 'Daily Loss Risk Gate Alert',
        message: '24h loss limit exceeded on BTCUSDT',
      },
      fetchImpl: mockFetch,
    });
    expect(r2.delivered).toBe(true);
    expect(sentPayloads[1].event).toBe('DAILY_LOSS_WARNING');

    const r3 = await notifyUserWebhookBestEffort({
      resolveWebhookUrl: async () => 'https://hooks.example.com/alerts',
      payload: {
        event: 'TOKEN_DEPLOYED',
        title: 'Token Deployed: $RTRD on base',
        message: 'Contract 0x1234... deployed via BYOK_VAULT',
      },
      fetchImpl: mockFetch,
    });
    expect(r3.delivered).toBe(true);
    expect(sentPayloads[2].event).toBe('TOKEN_DEPLOYED');
  });

  it('[AC1.3] notifyUserWebhookBestEffort NEVER throws on HTTP 500, network failure, or SSRF-blocked URL', async () => {
    const http500 = await notifyUserWebhookBestEffort({
      resolveWebhookUrl: async () => 'https://hooks.example.com/fail',
      payload: {
        event: 'ORDER_APPROVED',
        title: 'Order Approved',
        message: 'Test failure resilience',
      },
      fetchImpl: (async () => new Response('Internal Error', { status: 500 })) as typeof fetch,
    });
    expect(http500.attempted).toBe(true);
    expect(http500.delivered).toBe(false);
    expect(http500.statusCode).toBe(500);

    const ssrfBlocked = await notifyUserWebhookBestEffort({
      resolveWebhookUrl: async () => 'https://127.0.0.1/internal',
      payload: {
        event: 'TOKEN_DEPLOYED',
        title: 'Blocked SSRF',
        message: 'Should never reach localhost',
      },
    });
    expect(ssrfBlocked.attempted).toBe(true);
    expect(ssrfBlocked.delivered).toBe(false);
    expect(ssrfBlocked.error).toContain('SSRF_BLOCKED_HOST');
  });
});
