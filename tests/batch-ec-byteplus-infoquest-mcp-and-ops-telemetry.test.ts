/**
 * tests/batch-ec-byteplus-infoquest-mcp-and-ops-telemetry.test.ts
 *
 * Unit Suite #96 — Phase EC:
 *  - BytePlus Responses API + Info Quest MCP payload builder & explicit prompt_cache_key
 *  - Zero-secret getBytePlusEngineTelemetry() pool size & readiness calculation
 *  - Wiring in agent-scout-sync cron & admin ops-summary endpoint
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  BYTEPLUS_INFOQUEST_MCP_URL,
  buildBytePlusInfoQuestMcpPayload,
  getBytePlusEngineTelemetry,
} from '../packages/intelligence/llm-advisory-client';

describe('Phase EC: BytePlus Info Quest MCP Catalyst & Admin AI Engine Telemetry', () => {
  test('buildBytePlusInfoQuestMcpPayload configures Info Quest MCP and prompt_cache_key', () => {
    const payload = buildBytePlusInfoQuestMcpPayload({
      endpoint: ' ep-dola-seed-20-mini ',
      query: 'Base L2\nDeFi catalysts',
      cacheKey: 'poolnet-scout-v2',
    });

    expect(payload.model).toBe('ep-dola-seed-20-mini');
    expect(payload.store).toBe(false);
    expect(payload.prompt_cache_key).toBe('poolnet-scout-v2');
    expect(payload.tools).toEqual([
      {
        type: 'mcp',
        server_label: 'infoquest',
        server_url: BYTEPLUS_INFOQUEST_MCP_URL,
      },
    ]);
    expect(BYTEPLUS_INFOQUEST_MCP_URL).toBe('https://mcp.infoquest.bytepluses.com/mcp');
  });

  test('getBytePlusEngineTelemetry computes pool counts without leaking secrets', () => {
    const active = getBytePlusEngineTelemetry({
      AI_PRIMARY_PROVIDER: 'byteplus',
      BYTEDANCE_ARK_API_KEY: 'live-ark-key-123456',
      BYTEDANCE_BASE_URL: 'https://ark.ap-southeast.bytepluses.com/api/v3',
      BYTEDANCE_MODEL_ENDPOINT: 'ep-1,ep-2,ep-3',
      BYTEDANCE_DEEP_ENDPOINT: 'ep-deep-1,ep-deep-2',
      BYTEDANCE_IMAGE_ENDPOINT: 'ep-seedream-45',
      BYTEDANCE_INFOQUEST_ENABLED: '1',
      GEMINI_API_KEY: 'live-gemini-key',
    });

    expect(active).toEqual({
      configured: true,
      primaryProvider: 'byteplus',
      fastPoolSize: 3,
      deepPoolSize: 2,
      imagePoolSize: 1,
      infoQuestEnabled: true,
      geminiFallbackConfigured: true,
    });
    expect(JSON.stringify(active)).not.toContain('live-ark-key-123456');
    expect(JSON.stringify(active)).not.toContain('ep-1');

    const mockEnv = getBytePlusEngineTelemetry({
      BYTEDANCE_ARK_API_KEY: 'mock_key',
      BYTEDANCE_BASE_URL: 'https://ark.ap-southeast.bytepluses.com/api/v3',
      BYTEDANCE_MODEL_ENDPOINT: 'ep-1',
    });
    expect(mockEnv.configured).toBe(false);
    expect(mockEnv.infoQuestEnabled).toBe(false);
  });

  test('Scout sync cron and Admin ops-summary wire Info Quest MCP & AI telemetry', () => {
    const scoutRoute = readFileSync(
      join(process.cwd(), 'app/api/cron/agent-scout-sync/route.ts'),
      'utf8'
    );
    const opsRoute = readFileSync(
      join(process.cwd(), 'app/api/admin/ops-summary/route.ts'),
      'utf8'
    );

    expect(scoutRoute).toContain('fetchBytePlusInfoQuestCatalystHint');
    expect(opsRoute).toContain('getBytePlusEngineTelemetry');
    expect(opsRoute).toContain('aiEngine:');
  });
});
