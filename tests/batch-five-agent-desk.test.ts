import { describe, it, expect } from 'bun:test';
import { NextRequest } from 'next/server';
import {
  buildSanitizedAdvisoryPrompt,
  generateMarketAdvisoryNote,
} from '../packages/intelligence/llm-advisory-client';
import { runFiveAgentDeskCycle } from '../packages/agent/trading-desk-orchestrator';
import { POST as deskRunPOST } from '../app/api/agent/desk/run/route';
import { POST as bankrDeployPOST } from '../app/api/launchpad/bankr-deploy/route';
import { middleware } from '../middleware';

describe('5-Agent Trading Desk, BytePlus/Gemini Advisory & Stateless Bankr Client', () => {
  const sampleSignal: any = {
    symbol: 'BTCUSDT',
    computedConfidenceScore: 0.78,
    rationale: 'Positive momentum and healthy liquidity',
    riskFlags: [],
    inputs: {
      webSentiment: 'POSITIVE',
      counterpartyRisk: 'LOW',
      marketVolatility: 'MODERATE',
      volumeAnomaly: false,
    },
    computedAt: new Date().toISOString(),
  };

  it('buildSanitizedAdvisoryPrompt includes only public metrics and zero PII/secrets', () => {
    const prompt = buildSanitizedAdvisoryPrompt(sampleSignal, {
      symbol: 'BTCUSDT',
      action: 'BUY',
      suggestedQty: 50,
    });
    expect(prompt).toContain('BTCUSDT');
    expect(prompt).not.toContain('0x');
    expect(prompt).not.toContain('PRIVATE_KEY');
  });

  it('generateMarketAdvisoryNote returns deterministic-fallback when LLM keys are unconfigured', async () => {
    const prevArk = process.env.BYTEDANCE_ARK_API_KEY;
    const prevGem = process.env.GEMINI_API_KEY;
    delete process.env.BYTEDANCE_ARK_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const note = await generateMarketAdvisoryNote(sampleSignal, {
        symbol: 'BTCUSDT',
        action: 'BUY',
        suggestedQty: 50,
      });
      expect(note.provider).toBe('deterministic-fallback');
      expect(note.summary.length).toBeGreaterThan(10);
    } finally {
      if (prevArk !== undefined) process.env.BYTEDANCE_ARK_API_KEY = prevArk;
      if (prevGem !== undefined) process.env.GEMINI_API_KEY = prevGem;
    }
  });

  it('runFiveAgentDeskCycle executes all 5 agents sequentially with 0 collisions in PAPER mode', async () => {
    let savedIntents = 0;
    const report = await runFiveAgentDeskCycle(
      {
        userId: 'usr-desk-test',
        symbol: 'BTCUSDT',
        action: 'BUY',
        quantity: 25,
        maxSlippagePct: 1.0,
        mode: 'PAPER',
      },
      {
        proposalDb: {
          createProposal: async () => 'prop-12345678',
          getProposalById: async () => null,
          updateProposalStatus: async () => {},
          createAuditLog: async () => {},
        },
        getActiveLaunchesCount: async () => 3,
        getActiveKillSwitches: async () => [],
        getUserEntitlement: async () => ({ planId: 'TRADER', hasLiveTrading: true }),
        fetchMacroSignal: async () => null,
        generateAdvisory: async () => ({
          provider: 'deterministic-fallback',
          summary: 'Test advisory summary for BTCUSDT',
          caution: 'Verify limits',
          latencyMs: 1,
        }),
        saveTradeIntent: async () => {
          savedIntents += 1;
          return 'intent-paper-1';
        },
      }
    );

    expect(report.collisions).toBe(0);
    expect(report.rulesImmutable).toBe(true);
    expect(report.agents.map((a) => a.agent)).toEqual(['SCANNER', 'ANALYST', 'BRAIN', 'RISK', 'EXECUTOR']);
    expect(report.execution.status).toBe('FILLED_SIMULATED');
    expect(savedIntents).toBe(1);
    expect(report.readBackLog.length).toBeGreaterThanOrEqual(5);
  });

  it('Immutable Risk Agent blocks Executor when Kill Switch is active (zero orders placed)', async () => {
    let savedIntents = 0;
    const report = await runFiveAgentDeskCycle(
      {
        userId: 'usr-desk-test',
        symbol: 'BTCUSDT',
        action: 'BUY',
        quantity: 25,
        maxSlippagePct: 1.0,
        mode: 'PAPER',
      },
      {
        proposalDb: {
          createProposal: async () => 'prop-ks-1',
          getProposalById: async () => null,
          updateProposalStatus: async () => {},
          createAuditLog: async () => {},
        },
        getActiveLaunchesCount: async () => 1,
        getActiveKillSwitches: async () => [{ scope: 'GLOBAL', isActive: true, reason: 'Emergency Halt' }],
        getUserEntitlement: async () => ({ planId: 'TRADER', hasLiveTrading: true }),
        fetchMacroSignal: async () => null,
        generateAdvisory: async () => ({
          provider: 'deterministic-fallback',
          summary: 'Test advisory summary',
          caution: 'Verify limits',
          latencyMs: 1,
        }),
        saveTradeIntent: async () => {
          savedIntents += 1;
          return 'should-not-run';
        },
      }
    );

    expect(report.execution.status).toBe('BLOCKED_BY_RISK');
    expect(savedIntents).toBe(0);
    expect(report.agents.find((a) => a.agent === 'RISK')?.status).toBe('BLOCKED');
    expect(report.agents.find((a) => a.agent === 'EXECUTOR')?.status).toBe('BLOCKED');
  });

  it('LIVE_ADVISORY mode never auto-executes and returns READY_FOR_HUMAN_APPROVAL with /trading handoffUrl', async () => {
    let savedIntents = 0;
    const report = await runFiveAgentDeskCycle(
      {
        userId: 'usr-desk-test',
        symbol: 'BTCUSDT',
        action: 'BUY',
        quantity: 10,
        maxSlippagePct: 1.0,
        mode: 'LIVE_ADVISORY',
      },
      {
        proposalDb: {
          createProposal: async () => 'prop-live-1',
          getProposalById: async () => null,
          updateProposalStatus: async () => {},
          createAuditLog: async () => {},
        },
        getActiveLaunchesCount: async () => 2,
        getActiveKillSwitches: async () => [],
        getUserEntitlement: async () => ({ planId: 'TRADER', hasLiveTrading: true }),
        fetchMacroSignal: async () => null,
        generateAdvisory: async () => ({
          provider: 'deterministic-fallback',
          summary: 'Test advisory summary',
          caution: 'Verify limits',
          latencyMs: 1,
        }),
        saveTradeIntent: async () => {
          savedIntents += 1;
          return 'should-not-auto-save-live';
        },
      }
    );

    expect(report.execution.status).toBe('READY_FOR_HUMAN_APPROVAL');
    expect(report.execution.handoffUrl).toContain('/trading?symbol=BTCUSDT');
    expect(savedIntents).toBe(0);
  });

  it('POST /api/agent/desk/run and POST /api/launchpad/bankr-deploy fail closed (401) without SIWE session', async () => {
    const rDesk = new NextRequest('https://pndigi.site/api/agent/desk/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'BTCUSDT', action: 'BUY', quantity: 10 }),
    });
    expect((await middleware(rDesk)).status).toBe(401);
    expect((await deskRunPOST(rDesk)).status).toBe(401);

    const rBankr = new NextRequest('https://pndigi.site/api/launchpad/bankr-deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenName: 'Alpha', tokenSymbol: 'ALP', simulateOnly: true }),
    });
    expect((await middleware(rBankr)).status).toBe(401);
    expect((await bankrDeployPOST(rBankr)).status).toBe(401);
  });
});
