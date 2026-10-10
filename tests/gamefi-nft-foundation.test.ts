import { describe, it, expect } from 'bun:test';
import { ethers } from 'ethers';
import { NextRequest } from 'next/server';
import { GameFiService } from '../packages/gamefi/gamefi-service';
import { PostgresGameFiDbAdapter, defaultGameFiDbAdapter } from '../packages/shared/db-pool';
import { createSessionToken } from '../packages/auth/session';
import { POST as mintVoucherPOST } from '../app/api/gamefi/nft/mint-voucher/route';

describe('GameFi & NFT Foundation Unit & Security Suite', () => {
  const dbAdapter = new PostgresGameFiDbAdapter();
  const gameFiService = new GameFiService(dbAdapter);
  const testUserId = '0x1111111111111111111111111111111111111111';
  const testWallet = '0x2222222222222222222222222222222222222222';
  const testContract = '0x3333333333333333333333333333333333333333';

  it('1. should initialize default profile with 0 XP and level 1', async () => {
    const profile = await dbAdapter.getUserGameFiProfile(testUserId);
    expect(profile).toBeDefined();
    expect(profile.userId).toBe(testUserId);
    expect(profile.xp).toBe(0);
    expect(profile.level).toBe(1);
    expect(profile.questsCompleted).toBe(0);
  });

  it('2. should verify and complete connect_siwe quest, granting 100 XP', async () => {
    const res = await gameFiService.verifyAndCompleteQuest({
      userId: testUserId,
      walletAddress: testWallet,
      questId: 'connect_siwe',
    });

    expect(res.profile.xp).toBe(100);
    expect(res.profile.level).toBe(1);
    expect(res.profile.questsCompleted).toBe(1);
    expect(res.completion.status).toBe('COMPLETED');
    expect(res.completion.xpGranted).toBe(100);
  });

  it('3. should REJECT client-supplied condition flags if authoritative Sybil evidence is missing', async () => {
    // Client attempts to spoof conditions.isSybilVerified = true
    await expect(
      gameFiService.verifyAndCompleteQuest({
        userId: testUserId,
        walletAddress: testWallet,
        questId: 'verify_sybil',
        conditions: { isSybilVerified: true }, // Client spoof attempt
      })
    ).rejects.toThrow('QUEST_CONDITIONS_NOT_MET');
  });

  it('4. should approve verify_sybil quest when authoritative evidence is registered', async () => {
    // Authoritative evidence registered in DB
    dbAdapter.setMockSybilEvidence(testUserId, true);

    const res = await gameFiService.verifyAndCompleteQuest({
      userId: testUserId,
      walletAddress: testWallet,
      questId: 'verify_sybil',
    });

    expect(res.profile.xp).toBe(350); // 100 + 250
    expect(res.profile.level).toBe(1);
    expect(res.profile.questsCompleted).toBe(2);
  });

  it('5. should reject duplicate quest submissions and prevent double-granting XP (idempotency)', async () => {
    // Attempt to claim verify_sybil again
    await expect(
      gameFiService.verifyAndCompleteQuest({
        userId: testUserId,
        walletAddress: testWallet,
        questId: 'verify_sybil',
      })
    ).rejects.toThrow('QUEST_ALREADY_COMPLETED');

    const profile = await dbAdapter.getUserGameFiProfile(testUserId);
    expect(profile.xp).toBe(350); // XP unchanged!
  });

  it('6. should level up user when first_trade_or_launch brings XP past 500 threshold', async () => {
    dbAdapter.setMockTradeActivity(testUserId, true);

    const res = await gameFiService.verifyAndCompleteQuest({
      userId: testUserId,
      walletAddress: testWallet,
      questId: 'first_trade_or_launch',
    });

    expect(res.profile.xp).toBe(850); // 350 + 500
    expect(res.profile.level).toBe(2); // Math.floor(850/500) + 1 = 2
    expect(res.profile.questsCompleted).toBe(3);
  });

  it('7. should generate genuine EIP-712 typed-data signed mint voucher with contract and chain binding', async () => {
    const signer = ethers.Wallet.createRandom();
    const tier = 'GOLD';

    const voucher = await gameFiService.generateMintVoucher({
      recipientWallet: testWallet,
      tier,
      signerPrivateKey: signer.privateKey,
      contractAddress: testContract,
      chainId: 8453,
      ttlSeconds: 600,
    });

    expect(voucher.recipient).toBe(ethers.getAddress(testWallet));
    expect(voucher.tier).toBe('GOLD');
    expect(voucher.signature).toBeDefined();

    // Verify recovery using exact EIP-712 typed data verification
    const domain = {
      name: 'RTrader Trader Pass',
      version: '1',
      chainId: 8453n,
      verifyingContract: ethers.getAddress(testContract),
    };

    const types = {
      MintVoucher: [
        { name: 'recipient', type: 'address' },
        { name: 'tier', type: 'string' },
        { name: 'metadataUri', type: 'string' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    };

    const value = {
      recipient: ethers.getAddress(testWallet),
      tier: 'GOLD',
      metadataUri: voucher.metadataUri!,
      nonce: BigInt(voucher.nonce),
      deadline: BigInt(voucher.deadline),
    };

    const recovered = ethers.verifyTypedData(domain, types, value, voucher.signature);
    expect(recovered.toLowerCase()).toBe(signer.address.toLowerCase());

    // Adversarial: Cross-contract replay attempt (different verifyingContract) MUST recover a DIFFERENT address!
    const wrongDomain = { ...domain, verifyingContract: '0x4444444444444444444444444444444444444444' };
    const attackerRecovered = ethers.verifyTypedData(wrongDomain, types, value, voucher.signature);
    expect(attackerRecovered.toLowerCase()).not.toBe(signer.address.toLowerCase());
  });

  it('8. should construct valid OpenSea-compatible ERC-721 metadata JSON', () => {
    const meta = gameFiService.constructNftMetadata('GOLD', 'ipfs://QmTestHash/gold.png');
    expect(meta.name).toBe('RTrader GOLD Trader Pass');
    expect(meta.image).toBe('ipfs://QmTestHash/gold.png');
    expect(meta.attributes.length).toBe(3);
    expect(meta.attributes[0].trait_type).toBe('Pass Tier');
    expect(meta.attributes[0].value).toBe('GOLD');
  });

  describe('PostgreSQL Transaction Atomicity & Concurrency Suite', () => {
    it('9. should wrap quest completion and profile update in a single checked-out client PostgreSQL transaction', async () => {
      const executedQueries: string[] = [];
      let isReleased = false;

      const mockClient = {
        query: async (sql: string, params?: any[]) => {
          executedQueries.push(sql.trim().split('\n')[0]);
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
            return { rows: [] };
          }
          if (sql.includes('INSERT INTO quest_completions')) {
            return { rows: [{ id: 'completion-uuid-1', completed_at: new Date() }] };
          }
          if (sql.includes('INSERT INTO user_gamefi_profiles')) {
            return {
              rows: [
                {
                  userId: params?.[0],
                  xp: params?.[1],
                  level: 1,
                  questsCompleted: 1,
                  updatedAt: new Date(),
                },
              ],
            };
          }
          return { rows: [] };
        },
        release: () => {
          isReleased = true;
        },
      };

      const mockPool = {
        connect: async () => mockClient,
      };

      const pgAdapter = new PostgresGameFiDbAdapter(mockPool as any);
      const testUuid = '11111111-1111-1111-1111-111111111111';

      const result = await pgAdapter.recordQuestCompletion({
        userId: testUuid,
        questId: 'tx_quest_1',
        xpGranted: 150,
      });

      expect(result.completion.status).toBe('COMPLETED');
      expect(result.profile.xp).toBe(150);
      expect(executedQueries[0]).toBe('BEGIN');
      expect(executedQueries.some((q) => q.includes('INSERT INTO quest_completions'))).toBe(true);
      expect(executedQueries.some((q) => q.includes('INSERT INTO user_gamefi_profiles'))).toBe(true);
      expect(executedQueries[executedQueries.length - 1]).toBe('COMMIT');
      expect(isReleased).toBe(true);
    });

    it('10. should ROLLBACK and release client if profile update fails after completion insert, preventing orphaned completions', async () => {
      const executedQueries: string[] = [];
      let isReleased = false;

      const failClient = {
        query: async (sql: string, params?: any[]) => {
          executedQueries.push(sql.trim().split('\n')[0]);
          if (sql === 'BEGIN' || sql === 'ROLLBACK') {
            return { rows: [] };
          }
          if (sql.includes('INSERT INTO quest_completions')) {
            return { rows: [{ id: 'completion-uuid-fail', completed_at: new Date() }] };
          }
          if (sql.includes('INSERT INTO user_gamefi_profiles')) {
            throw new Error('SIMULATED_PROFILE_DEADLOCK');
          }
          return { rows: [] };
        },
        release: () => {
          isReleased = true;
        },
      };

      const failPool = {
        connect: async () => failClient,
      };

      const pgAdapter = new PostgresGameFiDbAdapter(failPool as any);
      const testUuid = '22222222-2222-2222-2222-222222222222';

      await expect(
        pgAdapter.recordQuestCompletion({
          userId: testUuid,
          questId: 'tx_quest_fail',
          xpGranted: 100,
        })
      ).rejects.toThrow('SIMULATED_PROFILE_DEADLOCK');

      expect(executedQueries[0]).toBe('BEGIN');
      expect(executedQueries.some((q) => q.includes('INSERT INTO quest_completions'))).toBe(true);
      expect(executedQueries.some((q) => q.includes('INSERT INTO user_gamefi_profiles'))).toBe(true);
      expect(executedQueries.includes('COMMIT')).toBe(false);
      expect(executedQueries[executedQueries.length - 1]).toBe('ROLLBACK');
      expect(isReleased).toBe(true);
    });

    it('11. should allow successful retry after a rolled-back failure without orphaned state blocking it', async () => {
      let failCount = 1;
      const executedQueries: string[] = [];
      let releaseCount = 0;

      const retryClient = {
        query: async (sql: string, params?: any[]) => {
          executedQueries.push(sql.trim().split('\n')[0]);
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
            return { rows: [] };
          }
          if (sql.includes('INSERT INTO quest_completions')) {
            return { rows: [{ id: 'completion-uuid-retry', completed_at: new Date() }] };
          }
          if (sql.includes('INSERT INTO user_gamefi_profiles')) {
            if (failCount > 0) {
              failCount--;
              throw new Error('TRANSIENT_LOCK_ERROR');
            }
            return {
              rows: [
                {
                  userId: params?.[0],
                  xp: params?.[1],
                  level: 1,
                  questsCompleted: 1,
                  updatedAt: new Date(),
                },
              ],
            };
          }
          return { rows: [] };
        },
        release: () => {
          releaseCount++;
        },
      };

      const retryPool = {
        connect: async () => retryClient,
      };

      const pgAdapter = new PostgresGameFiDbAdapter(retryPool as any);
      const testUuid = '33333333-3333-3333-3333-333333333333';

      // First attempt fails during profile increment and rolls back
      await expect(
        pgAdapter.recordQuestCompletion({
          userId: testUuid,
          questId: 'tx_quest_retry',
          xpGranted: 200,
        })
      ).rejects.toThrow('TRANSIENT_LOCK_ERROR');

      expect(releaseCount).toBe(1);

      // Second attempt (retry) succeeds because quest completion was NOT orphaned by previous attempt
      const successRes = await pgAdapter.recordQuestCompletion({
        userId: testUuid,
        questId: 'tx_quest_retry',
        xpGranted: 200,
      });

      expect(successRes.profile.xp).toBe(200);
      expect(releaseCount).toBe(2);
    });

    it('12. should ROLLBACK transaction and throw QUEST_ALREADY_COMPLETED on duplicate submission without updating profile', async () => {
      const executedQueries: string[] = [];
      let isReleased = false;

      const dupClient = {
        query: async (sql: string, params?: any[]) => {
          executedQueries.push(sql.trim().split('\n')[0]);
          if (sql === 'BEGIN' || sql === 'ROLLBACK') {
            return { rows: [] };
          }
          if (sql.includes('INSERT INTO quest_completions')) {
            // Unique constraint collision -> ON CONFLICT DO NOTHING -> 0 rows returned
            return { rows: [] };
          }
          if (sql.includes('INSERT INTO user_gamefi_profiles')) {
            throw new Error('PROFILE_INCREMENT_MUST_NOT_BE_CALLED_ON_DUPLICATE');
          }
          return { rows: [] };
        },
        release: () => {
          isReleased = true;
        },
      };

      const dupPool = {
        connect: async () => dupClient,
      };

      const pgAdapter = new PostgresGameFiDbAdapter(dupPool as any);
      const testUuid = '44444444-4444-4444-4444-444444444444';

      await expect(
        pgAdapter.recordQuestCompletion({
          userId: testUuid,
          questId: 'tx_quest_duplicate',
          xpGranted: 100,
        })
      ).rejects.toThrow('QUEST_ALREADY_COMPLETED');

      expect(executedQueries[0]).toBe('BEGIN');
      expect(executedQueries.some((q) => q.includes('INSERT INTO quest_completions'))).toBe(true);
      expect(executedQueries.some((q) => q.includes('INSERT INTO user_gamefi_profiles'))).toBe(false);
      expect(executedQueries.includes('COMMIT')).toBe(false);
      expect(executedQueries[executedQueries.length - 1]).toBe('ROLLBACK');
      expect(isReleased).toBe(true);
    });

    it('13. should handle concurrent duplicate submissions awarding XP exactly once', async () => {
      const concurrentUserId = '0xconcurren1111111111111111111111111111111';
      dbAdapter.clearInMemoryStores();

      // Fire two simultaneous completion requests for connect_siwe
      const results = await Promise.allSettled([
        gameFiService.verifyAndCompleteQuest({
          userId: concurrentUserId,
          walletAddress: testWallet,
          questId: 'connect_siwe',
        }),
        gameFiService.verifyAndCompleteQuest({
          userId: concurrentUserId,
          walletAddress: testWallet,
          questId: 'connect_siwe',
        }),
      ]);

      const successes = results.filter((r) => r.status === 'fulfilled');
      const failures = results.filter((r) => r.status === 'rejected');

      expect(successes.length).toBe(1);
      expect(failures.length).toBe(1);
      expect((failures[0] as PromiseRejectedResult).reason.message).toContain('QUEST_ALREADY_COMPLETED');

      const profile = await dbAdapter.getUserGameFiProfile(concurrentUserId);
      expect(profile.xp).toBe(100); // XP awarded exactly once!
    });
  });

  describe('Mint Voucher API Route Validation & Security Suite', () => {
    const voucherTestUserId = 'usr-voucher-tester-99';
    const voucherTestWallet = '0x9999999999999999999999999999999999999999';
    const randomSigner = ethers.Wallet.createRandom();

    const createVoucherRequest = (body: any, token?: string) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      return new NextRequest('http://localhost:3000/api/gamefi/nft/mint-voucher', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    };

    it('14. should reject unauthenticated voucher request with 401 UNAUTHORIZED', async () => {
      const req = createVoucherRequest({ tier: 'BRONZE' });
      const res = await mintVoucherPOST(req);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain('UNAUTHORIZED');
    });

    it('15. should reject unknown or invalid tiers with 400 INVALID_TIER', async () => {
      const token = createSessionToken({ userId: voucherTestUserId, walletAddress: voucherTestWallet });
      const req = createVoucherRequest({ tier: 'DIAMOND' }, token);
      const res = await mintVoucherPOST(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain('INVALID_TIER');
    });

    it('16. should reject SILVER tier request when user has insufficient XP with 403 INSUFFICIENT_XP', async () => {
      defaultGameFiDbAdapter.clearInMemoryStores();
      // Fresh user has 0 XP (< 250 XP required for SILVER)
      const token = createSessionToken({ userId: voucherTestUserId, walletAddress: voucherTestWallet });
      const req = createVoucherRequest({ tier: 'SILVER' }, token);
      const res = await mintVoucherPOST(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain('INSUFFICIENT_XP');
    });

    it('17. should reject GOLD tier request when user has insufficient XP with 403 INSUFFICIENT_XP', async () => {
      defaultGameFiDbAdapter.clearInMemoryStores();
      // Grant 300 XP (satisfies SILVER, but < 500 XP required for GOLD)
      await defaultGameFiDbAdapter.recordQuestCompletion({
        userId: voucherTestUserId,
        questId: 'test_grant_silver',
        xpGranted: 300,
      });

      const token = createSessionToken({ userId: voucherTestUserId, walletAddress: voucherTestWallet });
      const req = createVoucherRequest({ tier: 'GOLD' }, token);
      const res = await mintVoucherPOST(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain('INSUFFICIENT_XP');
    });

    it('18. should fail closed with 503 CONTRACT_UNCONFIGURED if contract address is missing from server configuration', async () => {
      const origContract = process.env.GAMEFI_PASS_CONTRACT_ADDRESS;
      const origPublic = process.env.NEXT_PUBLIC_GAMEFI_PASS_CONTRACT_ADDRESS;
      delete process.env.GAMEFI_PASS_CONTRACT_ADDRESS;
      delete process.env.NEXT_PUBLIC_GAMEFI_PASS_CONTRACT_ADDRESS;

      try {
        const token = createSessionToken({ userId: voucherTestUserId, walletAddress: voucherTestWallet });
        const req = createVoucherRequest({ tier: 'BRONZE' }, token);
        const res = await mintVoucherPOST(req);
        expect(res.status).toBe(503);
        const json = await res.json();
        expect(json.success).toBe(false);
        expect(json.error).toContain('CONTRACT_UNCONFIGURED');
      } finally {
        if (origContract) process.env.GAMEFI_PASS_CONTRACT_ADDRESS = origContract;
        if (origPublic) process.env.NEXT_PUBLIC_GAMEFI_PASS_CONTRACT_ADDRESS = origPublic;
      }
    });

    it('19. should strictly ignore client-supplied contractAddress and enforce server configured contract', async () => {
      const savedEnv = process.env.GAMEFI_PASS_CONTRACT_ADDRESS;
      const savedSigner = process.env.GAMEFI_VOUCHER_SIGNER_KEY;

      process.env.GAMEFI_PASS_CONTRACT_ADDRESS = testContract;
      process.env.GAMEFI_VOUCHER_SIGNER_KEY = randomSigner.privateKey;

      try {
        const token = createSessionToken({ userId: voucherTestUserId, walletAddress: voucherTestWallet });
        // Attacker passes arbitrary contract in body
        const req = createVoucherRequest(
          { tier: 'BRONZE', contractAddress: '0x9999999999999999999999999999999999999999' },
          token
        );
        const res = await mintVoucherPOST(req);
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.success).toBe(true);
        // Authoritative contract address MUST match server configured testContract, NOT attacker address!
        expect(json.voucher.contractAddress.toLowerCase()).toBe(testContract.toLowerCase());
      } finally {
        if (savedEnv) process.env.GAMEFI_PASS_CONTRACT_ADDRESS = savedEnv;
        else delete process.env.GAMEFI_PASS_CONTRACT_ADDRESS;
        if (savedSigner) process.env.GAMEFI_VOUCHER_SIGNER_KEY = savedSigner;
        else delete process.env.GAMEFI_VOUCHER_SIGNER_KEY;
      }
    });

    it('20. should fail closed with 503 SIGNER_UNAVAILABLE in production without isolated signer service (Rule 3)', async () => {
      const origNodeEnv = process.env.NODE_ENV;
      const origSignerUrl = process.env.GAMEFI_SIGNER_SERVICE_URL;
      (process.env as any).NODE_ENV = 'production';
      delete process.env.GAMEFI_SIGNER_SERVICE_URL;
      process.env.GAMEFI_PASS_CONTRACT_ADDRESS = testContract;

      try {
        const token = createSessionToken({ userId: voucherTestUserId, walletAddress: voucherTestWallet });
        const req = createVoucherRequest({ tier: 'BRONZE' }, token);
        const res = await mintVoucherPOST(req);
        expect(res.status).toBe(503);
        const json = await res.json();
        expect(json.success).toBe(false);
        expect(json.error).toContain('SIGNER_UNAVAILABLE');
      } finally {
        (process.env as any).NODE_ENV = origNodeEnv;
        if (origSignerUrl) process.env.GAMEFI_SIGNER_SERVICE_URL = origSignerUrl;
      }
    });

    it('21. should issue valid EIP-712 voucher when authenticated user satisfies requirements', async () => {
      defaultGameFiDbAdapter.clearInMemoryStores();
      // Grant 600 XP (qualifies for GOLD)
      await defaultGameFiDbAdapter.recordQuestCompletion({
        userId: voucherTestUserId,
        questId: 'test_gold_unlock',
        xpGranted: 600,
      });

      const savedEnv = process.env.GAMEFI_PASS_CONTRACT_ADDRESS;
      const savedSigner = process.env.GAMEFI_VOUCHER_SIGNER_KEY;

      process.env.GAMEFI_PASS_CONTRACT_ADDRESS = testContract;
      process.env.GAMEFI_VOUCHER_SIGNER_KEY = randomSigner.privateKey;

      try {
        const token = createSessionToken({ userId: voucherTestUserId, walletAddress: voucherTestWallet });
        const req = createVoucherRequest({ tier: 'GOLD' }, token);
        const res = await mintVoucherPOST(req);
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.success).toBe(true);
        expect(json.voucher.tier).toBe('GOLD');
        expect(json.voucher.recipient.toLowerCase()).toBe(voucherTestWallet.toLowerCase());

        // Verify cryptographic validity of signature
        const domain = {
          name: 'RTrader Trader Pass',
          version: '1',
          chainId: 8453n,
          verifyingContract: ethers.getAddress(testContract),
        };
        const types = {
          MintVoucher: [
            { name: 'recipient', type: 'address' },
            { name: 'tier', type: 'string' },
            { name: 'metadataUri', type: 'string' },
            { name: 'nonce', type: 'uint256' },
            { name: 'deadline', type: 'uint256' },
          ],
        };
        const value = {
          recipient: ethers.getAddress(voucherTestWallet),
          tier: 'GOLD',
          metadataUri: json.voucher.metadataUri,
          nonce: BigInt(json.voucher.nonce),
          deadline: BigInt(json.voucher.deadline),
        };

        const recovered = ethers.verifyTypedData(domain, types, value, json.voucher.signature);
        expect(recovered.toLowerCase()).toBe(randomSigner.address.toLowerCase());
      } finally {
        if (savedEnv) process.env.GAMEFI_PASS_CONTRACT_ADDRESS = savedEnv;
        else delete process.env.GAMEFI_PASS_CONTRACT_ADDRESS;
        if (savedSigner) process.env.GAMEFI_VOUCHER_SIGNER_KEY = savedSigner;
        else delete process.env.GAMEFI_VOUCHER_SIGNER_KEY;
      }
    });

    it('22. should reject remote signer responses with invalid schema with 502 SIGNER_INVALID_PAYLOAD', async () => {
      const origFetch = globalThis.fetch;
      const origSignerUrl = process.env.GAMEFI_SIGNER_SERVICE_URL;
      const origContract = process.env.GAMEFI_PASS_CONTRACT_ADDRESS;

      process.env.GAMEFI_SIGNER_SERVICE_URL = 'http://127.0.0.1:9999';
      process.env.GAMEFI_PASS_CONTRACT_ADDRESS = testContract;

      globalThis.fetch = (async () => {
        return new Response(JSON.stringify({ voucher: { invalid: 'payload' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as any;

      try {
        const token = createSessionToken({ userId: voucherTestUserId, walletAddress: voucherTestWallet });
        const req = createVoucherRequest({ tier: 'BRONZE' }, token);
        const res = await mintVoucherPOST(req);
        expect(res.status).toBe(502);
        const json = await res.json();
        expect(json.success).toBe(false);
        expect(json.error).toContain('SIGNER_INVALID_PAYLOAD');
      } finally {
        globalThis.fetch = origFetch;
        if (origSignerUrl) process.env.GAMEFI_SIGNER_SERVICE_URL = origSignerUrl;
        else delete process.env.GAMEFI_SIGNER_SERVICE_URL;
        if (origContract) process.env.GAMEFI_PASS_CONTRACT_ADDRESS = origContract;
        else delete process.env.GAMEFI_PASS_CONTRACT_ADDRESS;
      }
    });

    it('23. should handle remote signer timeout with 504 SIGNER_SERVICE_TIMEOUT', async () => {
      const origFetch = globalThis.fetch;
      const origSignerUrl = process.env.GAMEFI_SIGNER_SERVICE_URL;
      const origContract = process.env.GAMEFI_PASS_CONTRACT_ADDRESS;

      process.env.GAMEFI_SIGNER_SERVICE_URL = 'http://127.0.0.1:9999';
      process.env.GAMEFI_PASS_CONTRACT_ADDRESS = testContract;

      globalThis.fetch = (async () => {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
      }) as any;

      try {
        const token = createSessionToken({ userId: voucherTestUserId, walletAddress: voucherTestWallet });
        const req = createVoucherRequest({ tier: 'BRONZE' }, token);
        const res = await mintVoucherPOST(req);
        expect(res.status).toBe(504);
        const json = await res.json();
        expect(json.success).toBe(false);
        expect(json.error).toContain('SIGNER_SERVICE_TIMEOUT');
      } finally {
        globalThis.fetch = origFetch;
        if (origSignerUrl) process.env.GAMEFI_SIGNER_SERVICE_URL = origSignerUrl;
        else delete process.env.GAMEFI_SIGNER_SERVICE_URL;
        if (origContract) process.env.GAMEFI_PASS_CONTRACT_ADDRESS = origContract;
        else delete process.env.GAMEFI_PASS_CONTRACT_ADDRESS;
      }
    });

    it('24. should accept and return valid remote signer voucher payload', async () => {
      const origFetch = globalThis.fetch;
      const origSignerUrl = process.env.GAMEFI_SIGNER_SERVICE_URL;
      const origContract = process.env.GAMEFI_PASS_CONTRACT_ADDRESS;

      process.env.GAMEFI_SIGNER_SERVICE_URL = 'http://127.0.0.1:9999';
      process.env.GAMEFI_PASS_CONTRACT_ADDRESS = testContract;

      const dummyRemoteVoucher = {
        recipient: voucherTestWallet,
        tier: 'BRONZE',
        nonce: '99887766',
        deadline: Math.floor(Date.now() / 1000) + 600,
        signature: '0x' + 'ab'.repeat(65),
        metadataUri: 'ipfs://QmRemoteVoucherHash/bronze.json',
        contractAddress: ethers.getAddress(testContract),
        chainId: 8453,
      };

      globalThis.fetch = (async () => {
        return new Response(JSON.stringify({ voucher: dummyRemoteVoucher }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as any;

      try {
        const token = createSessionToken({ userId: voucherTestUserId, walletAddress: voucherTestWallet });
        const req = createVoucherRequest({ tier: 'BRONZE' }, token);
        const res = await mintVoucherPOST(req);
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.success).toBe(true);
        expect(json.voucher.signature).toBe(dummyRemoteVoucher.signature);
        expect(json.voucher.nonce).toBe(dummyRemoteVoucher.nonce);
      } finally {
        globalThis.fetch = origFetch;
        if (origSignerUrl) process.env.GAMEFI_SIGNER_SERVICE_URL = origSignerUrl;
        else delete process.env.GAMEFI_SIGNER_SERVICE_URL;
        if (origContract) process.env.GAMEFI_PASS_CONTRACT_ADDRESS = origContract;
        else delete process.env.GAMEFI_PASS_CONTRACT_ADDRESS;
      }
    });
  });
});
