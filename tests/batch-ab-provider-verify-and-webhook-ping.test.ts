import { describe, it, expect } from 'bun:test';
import { NextRequest } from 'next/server';
import { verifyByokLlmKeyLive } from '../packages/intelligence/llm-advisory-client';
import { POST as verifyProviderKeyPost } from '../app/api/user/provider-keys/verify/route';

describe('Phase AB: Live BYOK LLM Key Verifier (Zero-Token) & Webhook Test Ping', () => {
  it('[AB1.1] verifyByokLlmKeyLive checks GEMINI via read-only models endpoint and never echoes API key on error', async () => {
    let calledUrl = '';
    const okRes = await verifyByokLlmKeyLive({
      provider: 'GEMINI',
      apiKey: 'AIzaSySecretKeyTest123456',
      fetchImpl: (async (input: RequestInfo | URL) => {
        calledUrl = String(input);
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }) as typeof fetch,
    });
    expect(okRes.connected).toBe(true);
    expect(okRes.statusCode).toBe(200);
    expect(calledUrl).toContain('generativelanguage.googleapis.com/v1beta/models');

    const failRes = await verifyByokLlmKeyLive({
      provider: 'GEMINI',
      apiKey: 'AIzaSySecretKeyTest123456',
      fetchImpl: (async () => new Response('Unauthorized', { status: 403 })) as typeof fetch,
    });
    expect(failRes.connected).toBe(false);
    expect(failRes.error).toBe('AUTH_REJECTED_HTTP_403');
    expect(JSON.stringify(failRes)).not.toContain('AIzaSySecretKeyTest123456');
  });

  it('[AB1.2] verifyByokLlmKeyLive checks OPENAI & ANTHROPIC with exact auth headers', async () => {
    let openaiAuth = '';
    const openaiRes = await verifyByokLlmKeyLive({
      provider: 'OPENAI',
      apiKey: 'sk-proj-test-openai-key',
      fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        openaiAuth = String((init?.headers as Record<string, string>)?.Authorization || '');
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }) as typeof fetch,
    });
    expect(openaiRes.connected).toBe(true);
    expect(openaiAuth).toBe('Bearer sk-proj-test-openai-key');

    let antKey = '';
    let antVer = '';
    const antRes = await verifyByokLlmKeyLive({
      provider: 'ANTHROPIC',
      apiKey: 'sk-ant-test-claude-key',
      fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        const h = (init?.headers as Record<string, string>) || {};
        antKey = h['x-api-key'] || '';
        antVer = h['anthropic-version'] || '';
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }) as typeof fetch,
    });
    expect(antRes.connected).toBe(true);
    expect(antKey).toBe('sk-ant-test-claude-key');
    expect(antVer).toBe('2023-06-01');
  });

  it('[AB1.3] verifyByokLlmKeyLive rejects mock/empty keys and maps network failures safely', async () => {
    const mockRes = await verifyByokLlmKeyLive({
      provider: 'ANTHROPIC',
      apiKey: 'mock_claude_key',
    });
    expect(mockRes.connected).toBe(false);
    expect(mockRes.error).toBe('INVALID_OR_MOCK_API_KEY');

    const netRes = await verifyByokLlmKeyLive({
      provider: 'OPENAI',
      apiKey: 'sk-live-secret-999',
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED sk-live-secret-999');
      }) as typeof fetch,
    });
    expect(netRes.connected).toBe(false);
    expect(netRes.error).toBe('PROVIDER_NETWORK_ERROR');
    expect(JSON.stringify(netRes)).not.toContain('sk-live-secret-999');
  });

  it('[AB2.1] POST /api/user/provider-keys/verify fails closed (401) without SIWE session', async () => {
    const req = new NextRequest('http://localhost/api/user/provider-keys/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyId: 'key-1', provider: 'ANTHROPIC' }),
    });
    const res = await verifyProviderKeyPost(req);
    expect(res.status).toBe(401);
  });
});
