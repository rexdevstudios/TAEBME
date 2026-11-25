/**
 * tests/batch-ed-universal-ai-copilot-and-multi-account.test.ts
 *
 * Unit Suite #97 — Phase ED:
 *  - Natural-language intent parser (LIMIT order, MARKET order, Top Movers >%, Deployer Fees, Bankr Prompt)
 *  - Anti-Private-Key / Anti-Seed-Phrase leak guard
 *  - Multi-account exposure risk cap validator
 *  - API routes & Voice-enabled UI panel wiring
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  computeMultiAccountExposureCheck,
  filterTopMoversByPercent,
  parseCopilotUserMessage,
} from '../packages/agent/copilot-engine';

describe('Phase ED: Universal AI Trading & Launchpad Copilot + Voice + Multi-Account', () => {
  test('parseCopilotUserMessage parses Indonesian LIMIT order, Top Movers >%, Deployer Fees, and Bankr commands', () => {
    const limitCmd = parseCopilotUserMessage('Kalau BTC turun ke harga 88000 belikan limit sebesar $150');
    expect(limitCmd.valid).toBe(true);
    expect(limitCmd.kind).toBe('CEX_LIMIT_ORDER');
    expect(limitCmd.symbol).toBe('BTCUSDT');
    expect(limitCmd.side).toBe('BUY');
    expect(limitCmd.limitPrice).toBe(88000);
    expect(limitCmd.amountUsd).toBe(150);
    expect(limitCmd.actionDraft?.orderType).toBe('LIMIT');
    expect(limitCmd.actionDraft?.supportedRails).toEqual(['BINANCE', 'BYBIT']);

    const moversCmd = parseCopilotUserMessage('Apakah ada token yang naik di atas 7.5% hari ini?');
    expect(moversCmd.valid).toBe(true);
    expect(moversCmd.kind).toBe('TOP_MOVERS');
    expect(moversCmd.minChangePct).toBe(7.5);

    const feeCmd = parseCopilotUserMessage('Apakah deployer saya ada fee yang bisa di claim?');
    expect(feeCmd.valid).toBe(true);
    expect(feeCmd.kind).toBe('DEPLOYER_FEES');

    const bankrCmd = parseCopilotUserMessage('Swap $50 USDC ke ETH via Bankr');
    expect(bankrCmd.valid).toBe(true);
    expect(bankrCmd.kind).toBe('BANKR_PROMPT');
    expect(bankrCmd.actionDraft?.supportedRails).toEqual(['BANKR']);
  });

  test('parseCopilotUserMessage strictly blocks private keys and seed phrases', () => {
    const pkRes = parseCopilotUserMessage('0x' + 'a'.repeat(64));
    expect(pkRes.valid).toBe(false);
    expect(pkRes.error).toContain('SECURITY_BLOCK');

    const seedRes = parseCopilotUserMessage('Here is my seed phrase alpha beta gamma');
    expect(seedRes.valid).toBe(false);
    expect(seedRes.error).toContain('SECURITY_BLOCK');
  });

  test('filterTopMoversByPercent and computeMultiAccountExposureCheck enforce deterministic rules', () => {
    const movers = filterTopMoversByPercent(
      {
        BTCUSDT: { symbol: 'BTCUSDT', lastPrice: 92000, priceChangePct24h: 2.1, quoteVolumeUsd: 1e9 },
        SOLUSDT: { symbol: 'SOLUSDT', lastPrice: 210, priceChangePct24h: 8.4, quoteVolumeUsd: 5e8 },
        PEPEUSDT: { symbol: 'PEPEUSDT', lastPrice: 0.00002, priceChangePct24h: 14.2, quoteVolumeUsd: 2e8 },
      },
      5
    );
    expect(movers.map((m) => m.symbol)).toEqual(['PEPEUSDT', 'SOLUSDT']);

    const okExp = computeMultiAccountExposureCheck({
      amountUsdPerAccount: 100,
      selectedCount: 3,
      maxOrderValueUsd: 500,
      maxDailyLossUsd: 1000,
    });
    expect(okExp.ok).toBe(true);
    expect(okExp.totalExposureUsd).toBe(300);

    const overDaily = computeMultiAccountExposureCheck({
      amountUsdPerAccount: 400,
      selectedCount: 3,
      maxOrderValueUsd: 500,
      maxDailyLossUsd: 1000,
    });
    expect(overDaily.ok).toBe(false);
    expect(overDaily.reason).toContain('TOTAL_MULTI_ACCOUNT_EXPOSURE_EXCEEDS_DAILY_CAP');
  });

  test('Copilot API routes and Voice-enabled UI panel are wired cleanly on /agent', () => {
    const chatRoute = readFileSync(join(process.cwd(), 'app/api/agent/copilot/chat/route.ts'), 'utf8');
    const confirmRoute = readFileSync(join(process.cwd(), 'app/api/agent/copilot/confirm/route.ts'), 'utf8');
    const panel = readFileSync(join(process.cwd(), 'app/components/AiCopilotChatPanel.tsx'), 'utf8');
    const agentPage = readFileSync(join(process.cwd(), 'app/agent/page.tsx'), 'utf8');

    expect(chatRoute).toContain('parseCopilotUserMessage');
    expect(confirmRoute).toContain('COPILOT_MULTI_ACCOUNT_CONFIRMED');
    expect(confirmRoute).toContain('computeMultiAccountExposureCheck');
    expect(panel).toContain('webkitSpeechRecognition');
    expect(panel).toContain('Select All Accounts');
    expect(agentPage).toContain('AiCopilotChatPanel');
  });
});
