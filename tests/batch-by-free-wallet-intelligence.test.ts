import { describe, expect, test } from 'bun:test';
import {
  analyzeFreeWalletIntelligence,
  fetchFreeWalletProfile,
  KNOWN_PUBLIC_WALLET_ENTITIES,
} from '../packages/intelligence/free-wallet-intelligence';
import { ArkhamIntelligenceService } from '../packages/intelligence/arkham-enrichment';

const ZEROX_HOLDER = '0x0000000000001ff3684f28c67538d4d072c22734';
const SAMPLE_WALLET = '0x1111111111111111111111111111111111111111';

describe('Phase BY: Free Multi-Source On-Chain Wallet Intelligence (Replacing Paid Arkham)', () => {
  test('BY1.1 hard-blocks OFAC sanctioned / phishing / stealing_attack addresses with score 0', () => {
    const profile = analyzeFreeWalletIntelligence({
      address: SAMPLE_WALLET,
      chainId: 8453,
      goPlus: { sanctioned: '1', phishing_activities: '1' },
      rpcMaturity: { txCount: 120, balanceEth: 5, rpcReachable: true },
    });
    expect(profile.isCounterpartyBlocked).toBe(true);
    expect(profile.riskPassportScore).toBe(0);
    expect(profile.arkhamEntityType).toBe('SANCTIONED');
    expect(profile.tags).toContain('SANCTIONED_OFAC');
    expect(profile.tags).toContain('PHISHING_ACTIVITIES');
  });

  test('BY1.2 penalizes mixer exposure and fresh burner wallets while rewarding veteran whales', () => {
    const burner = analyzeFreeWalletIntelligence({
      address: SAMPLE_WALLET,
      chainId: 8453,
      goPlus: { mixer: '1' },
      rpcMaturity: { txCount: 0, balanceEth: 0, rpcReachable: true },
    });
    expect(burner.isCounterpartyBlocked).toBe(false);
    expect(burner.tags).toContain('MIXER_EXPOSURE');
    expect(burner.tags).toContain('FRESH_BURNER_WALLET');
    expect(burner.riskPassportScore).toBe(25); // 75 - 35 - 15

    const veteranWhale = analyzeFreeWalletIntelligence({
      address: SAMPLE_WALLET,
      chainId: 8453,
      goPlus: { sanctioned: '0' },
      rpcMaturity: { txCount: 250, balanceEth: 25, rpcReachable: true },
    });
    expect(veteranWhale.arkhamEntityType).toBe('WHALE');
    expect(veteranWhale.tags).toContain('VETERAN_WALLET');
    expect(veteranWhale.tags).toContain('HIGH_BALANCE_WHALE');
    expect(veteranWhale.riskPassportScore).toBe(90); // 75 + 10 + 5
  });

  test('BY1.3 recognizes curated public exchange & DeFi protocol entities without external API calls', () => {
    expect(KNOWN_PUBLIC_WALLET_ENTITIES[ZEROX_HOLDER]).toBeDefined();
    const profile = analyzeFreeWalletIntelligence({
      address: ZEROX_HOLDER,
      chainId: 8453,
      goPlus: { sanctioned: '0' },
    });
    expect(profile.arkhamEntityName).toBe('0x Protocol AllowanceHolder');
    expect(profile.arkhamEntityType).toBe('DEVELOPER');
    expect(profile.riskPassportScore).toBe(95);
    expect(profile.isCounterpartyBlocked).toBe(false);
  });

  test('BY1.4 fetchFreeWalletProfile combines GoPlus + RPC JSON-RPC batch and degrades gracefully on error', async () => {
    const mockFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('gopluslabs.io')) {
        return new Response(JSON.stringify({ code: 1, result: { sanctioned: '0', phishing_activities: '0' } }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify([
          { jsonrpc: '2.0', id: 1, result: '0x64' }, // 100 tx
          { jsonrpc: '2.0', id: 2, result: '0xde0b6b3a7640000' }, // 1 ETH
        ]),
        { status: 200 }
      );
    }) as typeof fetch;

    const okProfile = await fetchFreeWalletProfile({
      address: SAMPLE_WALLET,
      chainId: 8453,
      fetchImpl: mockFetch,
      bypassCache: true,
    });
    expect(okProfile.riskPassportScore).toBe(85); // 75 + 10 veteran
    expect(okProfile.tags).toContain('VETERAN_WALLET');

    const failFetch = (async () => {
      throw new Error('NETWORK_DOWN');
    }) as typeof fetch;
    const safeFallback = await fetchFreeWalletProfile({
      address: SAMPLE_WALLET,
      chainId: 8453,
      fetchImpl: failFetch,
      bypassCache: true,
    });
    expect(safeFallback.isCounterpartyBlocked).toBe(false);
    expect(safeFallback.riskPassportScore).toBe(75);
  });

  test('BY2.1 ArkhamIntelligenceService defaults to Free-First engine (zero Arkham paid API calls) when mock key is used', async () => {
    const auditActions: string[] = [];
    const svc = new ArkhamIntelligenceService('mock_arkham_api_key', {
      getArkhamProfile: async () => null,
      upsertArkhamProfile: async () => {},
      createAuditLog: async (_actor, action) => {
        auditActions.push(action);
      },
    });

    const profile = await svc.profileWallet(ZEROX_HOLDER, 'user-by-test');
    expect(profile.arkhamEntityName).toBe('0x Protocol AllowanceHolder');
    expect(profile.riskPassportScore).toBe(95);
    expect(auditActions).toContain('FREE_WALLET_INTELLIGENCE_PROFILED');
  });
});
