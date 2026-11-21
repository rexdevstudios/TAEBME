import { describe, it, expect } from 'bun:test';
import { ProviderRegistry } from '../packages/providers/registry';
import { assertSafeWebhookUrl, dispatchOutboundAlert } from '../packages/notifications/webhook-dispatcher';
import { GET as getProviderRegistry } from '../app/api/providers/registry/route';

describe('Phase Z2: Unified Provider Registry & SSRF-Safe Outbound Alert Dispatcher', () => {
  it('[Z2.1] ProviderRegistry exposes canonical CEX, Launchpad, LLM (BytePlus default), and Webhook providers', async () => {
    const all = ProviderRegistry.listAll();
    expect(all.length).toBeGreaterThanOrEqual(8);
    expect(ProviderRegistry.getById('BINANCE')?.status).toBe('LIVE');
    expect(ProviderRegistry.getById('BANKR')?.status).toBe('LIVE');
    expect(ProviderRegistry.getById('BYTEPLUS')?.category).toBe('LLM');
    expect(ProviderRegistry.getById('WEBHOOK')?.category).toBe('NOTIFICATION');

    const res = await getProviderRegistry();
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.defaultLlm.primary).toBeDefined();
    expect(Array.isArray(json.data.providers)).toBe(true);
  });

  it('[Z2.2] assertSafeWebhookUrl strictly blocks HTTP, localhost, loopback, metadata IP & RFC-1918 private hosts (SSRF Guard)', () => {
    expect(() => assertSafeWebhookUrl('http://discord.com/api/webhooks/123')).toThrow(/UNSAFE_WEBHOOK_PROTOCOL/);
    expect(() => assertSafeWebhookUrl('https://localhost:3000/hook')).toThrow(/SSRF_BLOCKED_HOST/);
    expect(() => assertSafeWebhookUrl('https://127.0.0.1/hook')).toThrow(/SSRF_BLOCKED_HOST/);
    expect(() => assertSafeWebhookUrl('https://169.254.169.254/latest/meta-data/')).toThrow(/SSRF_BLOCKED_HOST/);
    expect(() => assertSafeWebhookUrl('https://192.168.1.10/hook')).toThrow(/SSRF_BLOCKED_HOST/);
    expect(() => assertSafeWebhookUrl('https://10.0.0.5/hook')).toThrow(/SSRF_BLOCKED_HOST/);

    const ok = assertSafeWebhookUrl('https://discord.com/api/webhooks/123456/abcdef');
    expect(ok).toBe('https://discord.com/api/webhooks/123456/abcdef');
  });

  it('[Z2.3] dispatchOutboundAlert formats Discord & custom HTTPS webhook payloads cleanly', async () => {
    let capturedBody: any = null;
    const mockFetch = (async (_url: any, init?: any) => {
      capturedBody = JSON.parse(String(init?.body || '{}'));
      return new Response('ok', { status: 204 });
    }) as unknown as typeof fetch;

    const discordRes = await dispatchOutboundAlert({
      webhookUrl: 'https://discord.com/api/webhooks/999/token',
      payload: {
        event: 'ORDER_APPROVED',
        title: 'ETHUSDT BUY Approved',
        message: 'Order passed Risk Gate & 24h Daily Loss Guard.',
      },
      fetchImpl: mockFetch,
    });
    expect(discordRes.delivered).toBe(true);
    expect(capturedBody.content).toContain('ORDER_APPROVED');

    const customRes = await dispatchOutboundAlert({
      webhookUrl: 'https://hooks.example.com/poolnet',
      payload: {
        event: 'TOKEN_DEPLOYED',
        title: '$NOIR Live on Base',
        message: 'Deployed via Bankr BYOK Vault.',
        metadata: { chain: 'base' },
      },
      fetchImpl: mockFetch,
    });
    expect(customRes.delivered).toBe(true);
    expect(capturedBody.source).toBe('POOLNET_V25');
    expect(capturedBody.metadata.chain).toBe('base');
  });
});
