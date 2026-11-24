/**
 * Unit Suite #79 — Phase DL:
 * Bankr Agent Rail UI Panel + Binance Agentic Wallet (MPC) Non-Custodial Guardrail Bridge.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BINANCE_AGENTIC_SUPPORTED_CHAINS,
  buildBinanceAgenticSkillCommand,
  validateBinanceAgenticGuardrail,
} from '../packages/agent/binance-agentic-bridge';

describe('Phase DL — Binance Agentic Wallet (MPC) Guardrail Bridge', () => {
  test('validateBinanceAgenticGuardrail clamps limits and enforces dailyCap >= maxSingleTxUsd', () => {
    const badChains = validateBinanceAgenticGuardrail({ allowedChains: ['unknown-chain'] });
    expect(badChains.ok).toBe(false);

    const res = validateBinanceAgenticGuardrail({
      allowedChains: ['BSC', 'solana', 'invalid'],
      maxSingleTxUsd: 300,
      dailySpendCapUsd: 100, // lower than single tx -> auto-clamped up to 300
      requireGoPlusPreCheck: true,
    });
    expect(res.ok).toBe(true);
    expect(res.sanitized?.allowedChains).toEqual(['bsc', 'solana']);
    expect(res.sanitized?.maxSingleTxUsd).toBe(300);
    expect(res.sanitized?.dailySpendCapUsd).toBe(300);
    expect(BINANCE_AGENTIC_SUPPORTED_CHAINS).toEqual(['bsc', 'base', 'ethereum', 'solana']);
  });

  test('buildBinanceAgenticSkillCommand generates GoPlus-guarded, clamped non-custodial CLI commands', () => {
    const check = validateBinanceAgenticGuardrail({
      allowedChains: ['bsc', 'base'],
      maxSingleTxUsd: 150,
      dailySpendCapUsd: 600,
      requireGoPlusPreCheck: true,
    });
    const guardrail = check.sanitized!;

    const swapCmd = buildBinanceAgenticSkillCommand({
      chain: 'base',
      action: 'swap',
      tokenSymbol: 'degen; rm -rf /',
      amountUsd: 9999, // must clamp to maxSingleTxUsd (150)
      guardrail,
    });
    expect(swapCmd).toContain('--chain base');
    expect(swapCmd).toContain('--token DEGENRMRF');
    expect(swapCmd).toContain('--amount-usd 150');
    expect(swapCmd).toContain('--daily-cap-usd 600');
    expect(swapCmd).toContain('--precheck-goplus');

    const balCmd = buildBinanceAgenticSkillCommand({
      chain: 'bsc',
      action: 'balance',
      guardrail,
    });
    expect(balCmd).toBe('baw wallet balance --chain bsc --format json');
  });

  test('MultiRailAgentExecutionPanel is mounted in /agent Tab 3 and wires /api/agent/bankr-prompt cleanly', () => {
    const root = join(import.meta.dir, '..');
    const panelSrc = readFileSync(join(root, 'app/components/MultiRailAgentExecutionPanel.tsx'), 'utf8');
    expect(panelSrc).toContain('/api/agent/bankr-prompt');
    expect(panelSrc).toContain('buildBinanceAgenticSkillCommand');
    expect(panelSrc).toContain('validateBinanceAgenticGuardrail');

    const agentPageSrc = readFileSync(join(root, 'app/agent/page.tsx'), 'utf8');
    expect(agentPageSrc).toContain('<MultiRailAgentExecutionPanel isConnected={isConnected} />');
  });
});
