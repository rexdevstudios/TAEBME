import { describe, it, expect } from 'vitest';
import { buildAutonomousTerminalSnapshot } from '../packages/agent/autonomous-terminal-engine';
import { encodeDexSettlementIdempotencyKey } from '../packages/launchpad/web3-provider';
import { notifyUserWebhookBestEffort } from '../packages/notifications/webhook-dispatcher';

describe('Phase BG — Terminal Settlement Explorer Cards & DEX_SWAP_EXECUTED Webhook', () => {
  it('[BG1.1] buildAutonomousTerminalSnapshot enriches recentTradeCards with chainId, txHash, explorerUrl, and chainId handoff href from DEX settlement idempotencyKey', () => {
    const txHash = '0x' + 'c'.repeat(64);
    const idempotencyKey = encodeDexSettlementIdempotencyKey({
      chainId: 42161,
      txHash,
      intentId: 'intent_arb_settled_1234',
    });

    const snapshot = buildAutonomousTerminalSnapshot({
      planId: 'TRADER',
      intents: [
        {
          id: 'intent_arb_settled_1234',
          symbol: '0xaf88d065e77c8cc2239327c5edb3a432268e5831/WETH',
          side: 'BUY',
          stage: 'LIVE',
          quantity: 0.02,
          status: 'EXECUTED',
          idempotencyKey,
          createdAt: '2026-11-23T08:00:00.000Z',
        },
      ],
      activeLaunches: [],
      hasActiveCexKey: false,
      hasZeroXApiKey: true,
      hasFirecrawlApiKey: true,
    });

    expect(snapshot.recentTradeCards.length).toBeGreaterThanOrEqual(1);
    const card = snapshot.recentTradeCards[0];
    expect(card.id).toBe('intent_arb_settled_1234');
    expect(card.rail).toBe('EXTERNAL_DEX_0X');
    expect(card.chainId).toBe(42161);
    expect(card.txHash).toBe(txHash);
    expect(card.explorerUrl).toBe(`https://arbiscan.io/tx/${txHash}`);
    expect(card.href).toContain('chainId=42161');
    expect(card.href).toContain('mode=DEX_NON_CUSTODIAL');
  });

  it('[BG2.1] notifyUserWebhookBestEffort dispatches DEX_SWAP_EXECUTED payload with explorerUrl and txHash metadata', async () => {
    const capturedCalls: Array<{ url: string; body: any }> = [];
    const txHash = '0x' + 'd'.repeat(64);

    const mockFetch: typeof fetch = (async (input: any, init?: any) => {
      capturedCalls.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const result = await notifyUserWebhookBestEffort({
      resolveWebhookUrl: async () => 'https://hooks.slack.com/services/T000/B000/X000',
      payload: {
        event: 'DEX_SWAP_EXECUTED',
        title: '0x Swap v2 Settled On-Chain (BUY 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)',
        message: 'Wallet 0x1111...1111 confirmed DEX swap ($25 USD) on Chain #8453.',
        walletAddress: '0x1111111111111111111111111111111111111111',
        metadata: {
          intentId: 'intent_base_1',
          chainId: 8453,
          txHash,
          explorerUrl: `https://basescan.org/tx/${txHash}`,
        },
      },
      fetchImpl: mockFetch,
    });

    expect(result.attempted).toBe(true);
    expect(result.delivered).toBe(true);
    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0].body?.event).toBe('DEX_SWAP_EXECUTED');
    expect(capturedCalls[0].body?.metadata?.explorerUrl).toBe(`https://basescan.org/tx/${txHash}`);
  });
});
