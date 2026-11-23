import { describe, expect, test } from 'bun:test';
import {
  analyzeGoPlusTokenSecurity,
  detectSuspectedInsiderCluster,
  fetchOnChainTokenSecurity,
  isValidEvmAddress,
  parseGoPlusFractionToPct,
  resolveEvmChainIdFromNetwork,
  type GoPlusRawTokenSecurity,
} from '../packages/intelligence/onchain-insider-guard';
import { runFiveAgentDeskCycle } from '../packages/agent/trading-desk-orchestrator';

const SAMPLE_ADDR = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

describe('Phase BW: Free GoPlus On-Chain Anti-Insider, Cluster & Honeypot Guard', () => {
  test('BW1.1 validates EVM address, chain resolution, and GoPlus fraction-to-pct parser', () => {
    expect(isValidEvmAddress(SAMPLE_ADDR)).toBe(true);
    expect(isValidEvmAddress('not-an-address')).toBe(false);
    expect(resolveEvmChainIdFromNetwork('arbitrum')).toBe(42161);
    expect(resolveEvmChainIdFromNetwork('base', 1)).toBe(1);
    expect(resolveEvmChainIdFromNetwork('bsc')).toBe(56);
    expect(parseGoPlusFractionToPct('0.0523')).toBe(5.23);
    expect(parseGoPlusFractionToPct('0.25')).toBe(25);
    expect(parseGoPlusFractionToPct('')).toBe(0);
  });

  test('BW1.2 clean token produces LOW RISK, zero penalty, and hardBlocked=false', () => {
    const raw: GoPlusRawTokenSecurity = {
      token_name: 'USD Coin',
      token_symbol: 'USDC',
      is_honeypot: '0',
      cannot_sell_all: '0',
      buy_tax: '0',
      sell_tax: '0',
      is_mintable: '0',
      hidden_owner: '0',
      holder_count: '150000',
      creator_percent: '0',
      owner_percent: '0',
      holders: [
        { address: '0x1', percent: '0.08', is_contract: 0, is_locked: 0 },
        { address: '0x2', percent: '0.05', is_contract: 0, is_locked: 0 },
        { address: '0x3', percent: '0.35', is_contract: 1, is_locked: 0 }, // Contract excluded from top10 EOA
      ],
      lp_holders: [{ address: '0xlp', percent: '0.95', is_locked: 1 }],
    };

    const report = analyzeGoPlusTokenSecurity(raw, { address: SAMPLE_ADDR, chainId: 8453 });
    expect(report.riskLevel).toBe('LOW');
    expect(report.hardBlocked).toBe(false);
    expect(report.scorePenalty).toBe(0);
    expect(report.top10HolderPct).toBe(13);
    expect(report.lpLockedPct).toBe(95);
    expect(report.suspectedClusterCount).toBe(0);
    expect(report.redFlags.length).toBe(0);
  });

  test('BW1.3 honeypot or high sell tax (>20%) triggers CRITICAL hardBlocked=true', () => {
    const honeypotReport = analyzeGoPlusTokenSecurity(
      { is_honeypot: '1', sell_tax: '0', buy_tax: '0' },
      { address: SAMPLE_ADDR, chainId: 8453 }
    );
    expect(honeypotReport.hardBlocked).toBe(true);
    expect(honeypotReport.riskLevel).toBe('CRITICAL');
    expect(honeypotReport.redFlags).toContain('HONEYPOT_DETECTED');
    expect(honeypotReport.scorePenalty).toBe(-0.4);

    const taxTrapReport = analyzeGoPlusTokenSecurity(
      { is_honeypot: '0', sell_tax: '0.35', buy_tax: '0.02' },
      { address: SAMPLE_ADDR, chainId: 8453 }
    );
    expect(taxTrapReport.hardBlocked).toBe(true);
    expect(taxTrapReport.sellTaxPct).toBe(35);
    expect(taxTrapReport.redFlags).toContain('HIGH_SELL_TAX');
  });

  test('BW1.4 detects suspected same-entity insider wallet cluster (>=3 wallets with near-identical %)', () => {
    const clusterHolders = [
      { address: '0xa', percent: '0.0420', is_contract: 0, is_locked: 0 },
      { address: '0xb', percent: '0.0418', is_contract: 0, is_locked: 0 },
      { address: '0xc', percent: '0.0415', is_contract: 0, is_locked: 0 },
      { address: '0xd', percent: '0.0412', is_contract: 0, is_locked: 0 },
      { address: '0xe', percent: '0.0150', is_contract: 0, is_locked: 0 },
    ];
    expect(detectSuspectedInsiderCluster(clusterHolders)).toBe(4);

    const report = analyzeGoPlusTokenSecurity(
      {
        is_honeypot: '0',
        creator_percent: '0.12',
        holders: clusterHolders,
      },
      { address: SAMPLE_ADDR, chainId: 8453 }
    );
    expect(report.hardBlocked).toBe(false);
    expect(report.suspectedClusterCount).toBe(4);
    expect(report.redFlags).toContain('INSIDER_CLUSTER_SUSPECTED');
    expect(report.redFlags).toContain('DEV_HOLDING_HIGH');
    expect(report.riskLevel).toBe('HIGH');
    expect(report.scorePenalty).toBeLessThanOrEqual(-0.35);
  });

  test('BW1.5 fetchOnChainTokenSecurity parses GoPlus response and stays fault-isolated on network errors', async () => {
    const mockFetch = (async () =>
      new Response(
        JSON.stringify({
          code: 1,
          result: {
            [SAMPLE_ADDR.toLowerCase()]: {
              token_symbol: 'MOCK',
              is_honeypot: '0',
              buy_tax: '0.01',
              sell_tax: '0.01',
              holder_count: '420',
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )) as typeof fetch;

    const okReport = await fetchOnChainTokenSecurity({
      address: SAMPLE_ADDR,
      chainId: 8453,
      fetchImpl: mockFetch,
      bypassCache: true,
    });
    expect(okReport).not.toBeNull();
    expect(okReport?.tokenSymbol).toBe('MOCK');
    expect(okReport?.riskLevel).toBe('LOW');

    const failFetch = (async () => {
      throw new Error('ECONNRESET');
    }) as typeof fetch;
    const fallback = await fetchOnChainTokenSecurity({
      address: SAMPLE_ADDR,
      chainId: 8453,
      fetchImpl: failFetch,
      bypassCache: true,
    });
    expect(fallback).toBeNull();
  });

  test('BW2.1 5-Agent Trading Desk fail-closes immediately when GoPlus flags a honeypot token', async () => {
    const honeypotSecurity = analyzeGoPlusTokenSecurity(
      { is_honeypot: '1', token_symbol: 'RUG', sell_tax: '0.99' },
      { address: SAMPLE_ADDR, chainId: 8453 }
    );

    const report = await runFiveAgentDeskCycle(
      {
        userId: 'user-bw-test',
        symbol: 'RUG',
        action: 'BUY',
        quantity: 50,
        mode: 'PAPER',
        tokenAddress: SAMPLE_ADDR,
        chainId: 8453,
      },
      {
        proposalDb: {
          createProposal: async () => 'prop-unused',
          createAuditLog: async () => {},
        },
        getActiveLaunchesCount: async () => 1,
        getActiveKillSwitches: async () => [],
        getUserEntitlement: async () => ({ planId: 'TRADER', hasLiveTrading: true }),
        saveTradeIntent: async () => 'intent-unused',
        fetchMacroSignal: async () => null,
        fetchDexSnapshot: async () => null,
        fetchTokenSecurity: async () => honeypotSecurity,
      }
    );

    expect(report.tokenSecurity?.hardBlocked).toBe(true);
    expect(report.signal.riskFlags).toContain('HONEYPOT_DETECTED');
    expect(report.signal.riskFlags).toContain('COUNTERPARTY_BLOCKED');
    expect(report.execution.status).toBe('BLOCKED_BY_RISK');
    expect(report.proposal).toBeNull();
    expect(report.agents.find((a) => a.agent === 'ANALYST')?.status).toBe('BLOCKED');
    expect(report.agents.find((a) => a.agent === 'BRAIN')?.status).toBe('SKIPPED');
  });
});
