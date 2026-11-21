import { describe, it, expect } from 'bun:test';
import { generateMarketAdvisoryNote } from '../packages/intelligence/llm-advisory-client';
import { validateSessionAllowanceSpec } from '../packages/agent/session-allowance';
import { SubscriptionsEngine } from '../packages/billing/subscriptions-engine';

describe('Phase Y1–Y3: BYOK LLM Vault & Non-Custodial ERC-4337/7715 Session Allowance Spec', () => {
  it('[Y1.1] generateMarketAdvisoryNote accepts customSystemPrompt & falls back deterministically when keys are mock/absent', async () => {
    const prevArk = process.env.BYTEDANCE_ARK_API_KEY;
    const prevGem = process.env.GEMINI_API_KEY;
    process.env.BYTEDANCE_ARK_API_KEY = 'mock_ark';
    process.env.GEMINI_API_KEY = 'mock_gem';
    try {
      const note = await generateMarketAdvisoryNote(
        {
          symbol: 'ETHUSDT',
          computedConfidenceScore: 0.78,
          rationale: 'Volume expansion detected',
          riskFlags: [],
          inputs: {
            webSentiment: 'BULLISH',
            counterpartyRisk: 'LOW',
            marketVolatility: 'NORMAL',
            volumeAnomaly: false,
          },
          computedAt: new Date().toISOString(),
        },
        {
          symbol: 'ETHUSDT',
          action: 'BUY',
          suggestedQty: 0.5,
          customSystemPrompt: 'Focus on breakout volume confirmation and strict stop-loss discipline.',
          byokLlm: { provider: 'GEMINI', apiKey: 'mock_test_key' },
        }
      );
      expect(note.provider).toBe('deterministic-fallback');
      expect(note.summary.length).toBeGreaterThan(10);
      expect(note.caution.length).toBeGreaterThan(5);
    } finally {
      if (prevArk === undefined) delete process.env.BYTEDANCE_ARK_API_KEY;
      else process.env.BYTEDANCE_ARK_API_KEY = prevArk;
      if (prevGem === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevGem;
    }
  });

  it('[Y1.2] Billing tier SSOT restricts maxLlmKeys exclusively to TRADER & AGENT tiers', () => {
    expect(SubscriptionsEngine.getPlanCapacities('FREE').maxLlmKeys).toBe(0);
    expect(SubscriptionsEngine.getPlanCapacities('CREATOR').maxLlmKeys).toBe(0);
    expect(SubscriptionsEngine.getPlanCapacities('TRADER').maxLlmKeys).toBe(3);
    expect(SubscriptionsEngine.getPlanCapacities('AGENT').maxLlmKeys).toBe(5);
  });

  it('[Y2.1] validateSessionAllowanceSpec enforces Non-Custodial guard, 30-day TTL cap, and tier spend clamping', () => {
    const now = Date.now();
    const validExpiry = new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString();
    const valid = validateSessionAllowanceSpec(
      {
        delegateAddress: '0x1111111111111111111111111111111111111111',
        chainId: 8453,
        dailySpendCapUsd: 5000, // FREE tier max is $250 -> must clamp to $250
        expiresAtIso: validExpiry,
        allowedContracts: ['0x4200000000000000000000000000000000000006'],
        allowedActions: ['MINT_NFT', 'SWAP_DEX'],
      },
      'FREE',
      now
    );
    expect(valid.standard).toBe('ERC-4337/ERC-7715');
    expect(valid.effectiveDailySpendCapUsd).toBe(250);
    expect(valid.allowedContracts.length).toBe(1);

    // Rejects private key pasted into delegateAddress (AGENTS.md Rule 3)
    expect(() =>
      validateSessionAllowanceSpec(
        {
          delegateAddress: '0x' + 'ab'.repeat(32),
          chainId: 8453,
          dailySpendCapUsd: 50,
          expiresAtIso: validExpiry,
          allowedContracts: ['0x4200000000000000000000000000000000000006'],
          allowedActions: ['MINT_NFT'],
        },
        'AGENT',
        now
      )
    ).toThrow(/FORBIDDEN_PRIVATE_KEY_INPUT/);

    // Rejects expiry > 30 days
    const tooLongExpiry = new Date(now + 45 * 24 * 60 * 60 * 1000).toISOString();
    expect(() =>
      validateSessionAllowanceSpec(
        {
          delegateAddress: '0x1111111111111111111111111111111111111111',
          chainId: 8453,
          dailySpendCapUsd: 50,
          expiresAtIso: tooLongExpiry,
          allowedContracts: ['0x4200000000000000000000000000000000000006'],
          allowedActions: ['SWAP_DEX'],
        },
        'AGENT',
        now
      )
    ).toThrow(/EXPIRY_EXCEEDS_MAX_30_DAYS/);
  });
});
