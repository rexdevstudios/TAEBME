import { describe, it, expect } from 'vitest';
import { validateAndClampAutoPilotConfig } from '../packages/agent/autopilot-policy';
import { runAutoPilotWorkerTick } from '../packages/agent/autopilot-sweep';

describe('Phase BS — Opt-In Live CEX Auto-Execution & Bybit V5 Single-Shot Dispatch', () => {
  it('[BS1.1] validateAndClampAutoPilotConfig defaults autoExecuteCex to false and forces false on DEX_SESSION rail', () => {
    const traderDefault = validateAndClampAutoPilotConfig(
      { enabled: true, rail: 'CEX_AUTO', maxOrderUsd: 200 },
      'TRADER'
    );
    expect(traderDefault.config.autoExecuteCex).toBe(false);

    const traderOptIn = validateAndClampAutoPilotConfig(
      { enabled: true, rail: 'CEX_AUTO', autoExecuteCex: true, maxOrderUsd: 200 },
      'TRADER'
    );
    expect(traderOptIn.config.autoExecuteCex).toBe(true);

    const agentDex = validateAndClampAutoPilotConfig(
      { enabled: true, rail: 'DEX_SESSION', autoExecuteCex: true, maxOrderUsd: 500 },
      'AGENT'
    );
    expect(agentDex.config.autoExecuteCex).toBe(false);
  });

  it('[BS2.1] runAutoPilotWorkerTick dispatches Bybit V5 Spot order with deterministic orderLinkId when autoExecuteCex=true', async () => {
    const capturedBodies: any[] = [];
    const mockFetch: typeof fetch = (async (_input: any, init?: any) => {
      if (init?.body) capturedBodies.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({ retCode: 0, retMsg: 'OK', result: { orderId: 'bybit-ord-bs-1' } }),
        { status: 200 }
      );
    }) as typeof fetch;

    const res = await runAutoPilotWorkerTick({
      userId: 'usr-bs-trader',
      walletAddress: '0x1111111111111111111111111111111111111111',
      planId: 'TRADER',
      stage: 'TESTNET',
      config: {
        enabled: true,
        rail: 'CEX_AUTO',
        autoExecuteCex: true,
        maxOrderUsd: 200,
        takeProfitPct: 10,
        stopLossPct: 5,
        minConfidenceScore: 75,
        allowedSymbols: ['BTCUSDT'],
        updatedAt: new Date().toISOString(),
      },
      marketSignals: [{ symbol: 'BTCUSDT', confidenceScore: 88, suggestedOrderUsd: 100 }],
      openPositions: [],
      dryRun: false,
      nowMs: 1_700_000_000_000,
      fetchImpl: mockFetch,
      bybitCredentialOverride: {
        apiKey: 'test_bybit_key_12345',
        secretKey: 'test_bybit_secret_12345',
        environment: 'TESTNET',
      },
    });

    expect(res.queuedCount).toBe(1);
    expect(res.cexExecutedCount).toBe(1);
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].symbol).toBe('BTCUSDT');
    expect(capturedBodies[0].side).toBe('Buy');
    expect(String(capturedBodies[0].orderLinkId)).toContain('ap_usrbstrade_BTCUSDT_BUY_');
  });
});
