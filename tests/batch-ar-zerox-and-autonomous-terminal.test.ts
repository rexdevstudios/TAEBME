/**
 * tests/batch-ar-zerox-and-autonomous-terminal.test.ts
 *
 * Phase AR Unit Tests:
 * 1. `buildZeroXQuoteUrl` & `fetchZeroXSwapQuote` (0x v2 headers, Auto-ETH fee to treasury,
 *    unsupported chain fallback, timeout safety).
 * 2. `buildAutonomousTerminalSnapshot` (4-Sub-Agent attribution, Dual-Rail readiness & live feed).
 * 3. `GET /api/agent/terminal-telemetry` fails closed with HTTP 401 without SIWE session.
 */

import { describe, it, expect } from 'bun:test';
import { NextRequest } from 'next/server';
import { buildDexPartnerFeePayload } from '../packages/trading/fee-monetization';
import {
  ZEROX_NATIVE_ETH,
  buildZeroXQuoteUrl,
  fetchZeroXSwapQuote,
} from '../packages/trading/zerox-swap-client';
import { buildAutonomousTerminalSnapshot } from '../packages/agent/autonomous-terminal-engine';
import { GET as getTerminalTelemetry } from '../app/api/agent/terminal-telemetry/route';

describe('Phase AR — Live 0x Swap v2 Client & Dual-Rail 4-Sub-Agent Terminal', () => {
  const taker = '0x4444444444444444444444444444444444444444';
  const baseUsdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const treasury = '0x0c9f4a82b5ae258e8e65ca40ac4f1abc455c34b6';

  it('builds 0x v2 quote URL with swapFeeBps, swapFeeRecipient, and native ETH swapFeeToken', () => {
    const url = buildZeroXQuoteUrl({
      chainId: 8453,
      sellToken: ZEROX_NATIVE_ETH,
      buyToken: baseUsdc,
      sellAmount: '10000000000000000',
      taker,
      slippageBps: 100,
      feeBps: 25,
      feeRecipient: treasury,
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('chainId')).toBe('8453');
    expect(parsed.searchParams.get('swapFeeBps')).toBe('25');
    expect(parsed.searchParams.get('swapFeeRecipient')).toBe(treasury);
    expect(parsed.searchParams.get('swapFeeToken')).toBe(ZEROX_NATIVE_ETH);
  });

  it('fetches 0x Swap v2 quote cleanly with mocked transport and handles unsupported chain/timeout', async () => {
    let capturedHeaders: Record<string, string> = {};
    const partnerFee = buildDexPartnerFeePayload({ dexSwapFeeBps: 25, treasuryWallet: treasury, chainId: 8453 });

    const okFetch = (async (_url: any, init: any) => {
      capturedHeaders = init?.headers || {};
      return new Response(
        JSON.stringify({
          sellAmount: '10000000000000000',
          buyAmount: '32000000',
          minBuyAmount: '31680000',
          transaction: {
            to: '0x0000000000001fF3684f28c67538d4D072C22734',
            data: '0xdeadbeef',
            value: '10000000000000000',
            gas: '210000',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;

    const okRes = await fetchZeroXSwapQuote({
      chainId: 8453,
      side: 'BUY',
      tokenAddress: baseUsdc,
      sellAmountWei: '10000000000000000',
      takerAddress: taker,
      slippageBps: 100,
      partnerFee,
      apiKeyOverride: 'test-0x-key-valid',
      fetchImpl: okFetch,
    });

    expect(okRes.available).toBe(true);
    expect(okRes.transaction?.to).toBe('0x0000000000001fF3684f28c67538d4D072C22734');
    expect(okRes.feeToken).toBe(ZEROX_NATIVE_ETH);
    expect(capturedHeaders['0x-api-key']).toBe('test-0x-key-valid');
    expect(capturedHeaders['0x-version']).toBe('v2');

    // Unsupported testnet chainId (Base Sepolia 84532) fails safe without throwing
    const unsupported = await fetchZeroXSwapQuote({
      chainId: 84532,
      side: 'BUY',
      tokenAddress: baseUsdc,
      sellAmountWei: '10000000000000000',
      takerAddress: taker,
      slippageBps: 100,
      partnerFee,
      apiKeyOverride: 'test-0x-key-valid',
    });
    expect(unsupported.available).toBe(false);
    expect(unsupported.reason).toBe('ZEROX_UNSUPPORTED_CHAIN_84532');
  });

  it('builds Dual-Rail 4-Sub-Agent terminal snapshot covering Internal Launchpad, External DEX 0x & External CEX Auto', () => {
    const snap = buildAutonomousTerminalSnapshot({
      planId: 'AGENT',
      intents: [
        {
          id: 'i1',
          userId: 'u1',
          stage: 'PAPER',
          symbol: 'LAVA/WETH',
          side: 'BUY',
          type: 'MARKET',
          quantity: 0.1,
          maxSlippagePct: 1,
          idempotencyKey: 'k1',
          status: 'APPROVED',
        },
        {
          id: 'i2',
          userId: 'u1',
          stage: 'LIVE',
          symbol: 'BTCUSDT',
          side: 'BUY',
          type: 'MARKET',
          quantity: 0.02,
          maxSlippagePct: 1,
          idempotencyKey: 'k2',
          status: 'APPROVED',
        },
      ],
      activeLaunches: [
        { ticker: 'LAVA', contractAddress: baseUsdc, isGraduated: false, bondingProgressPct: 40 },
        { ticker: 'YETI', contractAddress: baseUsdc, isGraduated: true, bondingProgressPct: 100 },
      ],
      hasActiveCexKey: true,
      hasZeroXApiKey: true,
      hasFirecrawlApiKey: true,
    });

    expect(snap.mode).toBe('LIVE_NON_CUSTODIAL');
    expect(snap.agentBreakdown.length).toBe(4);
    expect(snap.dualRailReadiness.internalLaunchpadCount).toBe(2);
    expect(snap.dualRailReadiness.externalDexZeroXReady).toBe(true);
    expect(snap.dualRailReadiness.externalCexAutoReady).toBe(true);

    const rails = new Set(snap.liveFeed.map((f) => f.rail));
    expect(rails.has('INTERNAL_LAUNCHPAD')).toBe(true);
    expect(rails.has('EXTERNAL_DEX_0X')).toBe(true);
    expect(rails.has('EXTERNAL_CEX_AUTO')).toBe(true);
  });

  it('GET /api/agent/terminal-telemetry fails closed with HTTP 401 when unauthenticated', async () => {
    const req = new NextRequest('http://localhost:3000/api/agent/terminal-telemetry', { method: 'GET' });
    const res = await getTerminalTelemetry(req);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.success).toBe(false);
  });
});
