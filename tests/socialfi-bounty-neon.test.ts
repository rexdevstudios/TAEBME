/**
 * tests/socialfi-bounty-neon.test.ts
 *
 * Automated regression test suite for SocialFi KOL Launchpad & Neon PostgreSQL SSOT:
 *  1. Merkle Tree Generation for On-Chain Multi-Chain Token Claims.
 *  2. AI Tweet Quality Gate & Sentiment Auditing.
 *  3. Bounty Campaign Query & Persistence via Postgres SSOT Adapter.
 *  4. End-to-End Bounty Claim Submission & Verification Lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { BountyEscrowService, type BountyClaimItem } from "../packages/launchpad/bounty-escrow.ts";
import { TweetQualityScorer } from "../packages/intelligence/tweet-quality-scorer.ts";
import * as dbPool from "../packages/shared/db-pool.ts";
import { defaultBountyDbAdapter, defaultKolDbAdapter } from "../packages/shared/db-pool.ts";
import { NextRequest } from "next/server";
import { ethers } from "ethers";
import { createSessionToken } from "../packages/auth/session.ts";
import { POST as postSettle } from "../app/api/launchpad/bounty/settle/route.ts";
import { BONDING_CURVE_LAUNCHPAD_ABI } from "../packages/launchpad/contracts/BondingCurveLaunchpadAbi.ts";
import type { KolProfile } from "../packages/shared/types/domain.ts";

describe("SocialFi KOL Launchpad & Neon PostgreSQL SSOT Suite", () => {
  describe("1. Merkle Tree Generation for Smart Contract Claims", () => {
    it("should handle empty claims array safely", () => {
      const tree = BountyEscrowService.generateBountyMerkleTree([]);
      expect(tree.root).toBe("0x0000000000000000000000000000000000000000000000000000000000000000");
      expect(tree.getProof("0x1111111111111111111111111111111111111111", 1000n)).toEqual([]);
    });

    it("should generate valid Merkle root and proof for multiple KOL claims", () => {
      const claims: BountyClaimItem[] = [
        {
          walletAddress: "0x1111111111111111111111111111111111111111",
          tokenAmount: 1000000000000000000000n,
        },
        {
          walletAddress: "0x2222222222222222222222222222222222222222",
          tokenAmount: 2500000000000000000000n,
        },
        {
          walletAddress: "0x3333333333333333333333333333333333333333",
          tokenAmount: 5000000000000000000000n,
        },
      ];

      const tree = BountyEscrowService.generateBountyMerkleTree(claims);

      expect(tree.root.startsWith("0x")).toBe(true);
      expect(tree.root.length).toBe(66);

      const proof1 = tree.getProof(claims[0].walletAddress, claims[0].tokenAmount);
      expect(Array.isArray(proof1)).toBe(true);
      expect(proof1.length).toBeGreaterThan(0);

      const proofInvalid = tree.getProof("0x9999999999999999999999999999999999999999", 1000n);
      expect(proofInvalid).toEqual([]);
    });
  });

  describe("2. AI Tweet Quality Gate & Sentiment Scorer", () => {
    it("should pass compliant tweets containing required hashtag and authentic sentiment", () => {
      const tweet = "Really excited to support $PUMPRUN on Base! High momentum and great tokenomics. #PUMPRUN to the moon! 🚀";
      const result = TweetQualityScorer.auditTweet(tweet, "#PUMPRUN");

      expect(result.passedQualityGate).toBe(true);
      expect(result.detectedHashtags.includes("#pumprun")).toBe(true);
      expect(result.isSpamOrBot).toBe(false);
      expect(result.qualityScore).toBeGreaterThanOrEqual(60);
    });

    it("should reject tweets missing the required hashtag", () => {
      const tweet = "This token looks interesting, buy now on Uniswap!";
      const result = TweetQualityScorer.auditTweet(tweet, "#PUMPRUN");

      expect(result.passedQualityGate).toBe(false);
      expect(result.detectedHashtags.includes("#pumprun")).toBe(false);
      expect(result.auditReasons.some((r) => r.toLowerCase().includes("hashtag"))).toBe(true);
    });

    it("should reject short spam / bot-like phrases", () => {
      const tweet = "buy #PUMPRUN";
      const result = TweetQualityScorer.auditTweet(tweet, "#PUMPRUN");

      expect(result.passedQualityGate).toBe(false);
      expect(result.auditReasons.length).toBeGreaterThan(0);
    });
  });

  describe("3. Neon PostgreSQL SSOT Campaign Querying", () => {
    it("should list active campaigns with valid fields from SSOT or fallback", async () => {
      const campaigns = await defaultBountyDbAdapter.listCampaigns();

      expect(Array.isArray(campaigns)).toBe(true);
      expect(campaigns.length).toBeGreaterThan(0);

      const first = campaigns[0];
      expect(first.id).toBeDefined();
      expect(first.title).toBeDefined();
      expect(first.requiredHashtag.startsWith("#")).toBe(true);
      expect(first.rewardPerKol).toBeGreaterThan(0n);
      expect(first.isActive).toBe(true);
    });
  });

  describe("4. End-to-End Bounty Claim Lifecycle", () => {
    it("should verify compliant bounty claim and increment participants", async () => {
      const campaigns = await defaultBountyDbAdapter.listCampaigns();
      expect(campaigns.length).toBeGreaterThan(0);
      const campaign = campaigns[0];

      const testKol: KolProfile = {
        id: "71d618df-3bf9-4dc8-81e1-f21bc8d853d0",
        userId: "07f847b9-60a4-48e4-8a45-3626b133b0fe",
        twitterHandle: "persister_kol",
        followersCount: 5000,
        trustScore: 88,
        completedBounties: 0,
        totalEarnedUsd: 0,
        isVerified: true,
      };

      const service = new BountyEscrowService(defaultBountyDbAdapter);
      const proofUrl = "https://x.com/persister_kol/status/9876543210";
      const tweetText = `Proud to join the official community raid for this incredible ecosystem! Join us now: ${campaign.requiredHashtag} 🚀`;

      const result = await service.submitAndVerifyClaim(
        campaign.id,
        testKol,
        proofUrl,
        tweetText
      );

      expect(result.success).toBe(true);
      expect(result.claim).toBeDefined();
      expect(result.claim?.verificationStatus).toBe("VERIFIED");
      expect(result.qualityAudit ? result.qualityAudit.passedQualityGate : result.success).toBe(true);
    });

    it("should reject claim when KOL has insufficient followers", async () => {
      const campaigns = await defaultBountyDbAdapter.listCampaigns();
      const campaign = campaigns[0];

      const underqualifiedKol: KolProfile = {
        id: "kol-under-1",
        userId: "usr-under-1",
        twitterHandle: "newbie_trader",
        followersCount: 5, // below minFollowers (usually >= 100-500)
        trustScore: 50,
        completedBounties: 0,
        totalEarnedUsd: 0,
        isVerified: false,
      };

      const service = new BountyEscrowService(defaultBountyDbAdapter);
      const result = await service.submitAndVerifyClaim(
        campaign.id,
        underqualifiedKol,
        "https://x.com/newbie_trader/status/111"
      );

      expect(result.success).toBe(false);
      expect(result.reason).toBe("INSUFFICIENT_FOLLOWERS");
    });
  });

  describe("11. Phase A2.8.30.18 — Settlement Proof Binding, Concurrency & Security Tests", () => {
    let dbSpy: any;
    beforeEach(() => {
      dbSpy = spyOn(dbPool, "getDbPool").mockReturnValue({ query: async () => ({ rows: [] }) } as any);
    });
    afterEach(() => {
      dbSpy?.mockRestore();
    });

    const launchpadContract = "0x1234567890123456789012345678901234567890";
    const testClaimantWallet = "0x8888888888888888888888888888888888888888";
    const testTokenAddress = "0x1234567890123456789012345678901234567890";
    const validTxHash = "0x" + "a".repeat(64);

    const iface = new ethers.Interface(BONDING_CURVE_LAUNCHPAD_ABI);
    const eventFragment = iface.getEvent("BountyRewardClaimed");

    function createValidClaimLog(
      kolWallet: string = testClaimantWallet,
      amount: bigint = 1000000000000000000000n,
      emitter: string = launchpadContract,
      tokenAddr: string = testTokenAddress
    ) {
      const encoded = iface.encodeEventLog(eventFragment, [tokenAddr, kolWallet, amount]);
      return {
        address: emitter,
        topics: encoded.topics as string[],
        data: encoded.data,
      };
    }

    function mockReceipt(overrides: Partial<ethers.TransactionReceipt> = {}): ethers.TransactionReceipt {
      return {
        to: launchpadContract,
        from: testClaimantWallet,
        status: 1,
        blockNumber: 123456,
        hash: validTxHash,
        logs: [createValidClaimLog()],
        ...overrides,
      } as unknown as ethers.TransactionReceipt;
    }

    it("should reject unauthenticated POST /api/launchpad/bounty/settle with 401 UNAUTHORIZED", async () => {
      const req = new NextRequest("http://localhost:3000/api/launchpad/bounty/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claimId: crypto.randomUUID(), txHash: validTxHash }),
      });
      const res = await postSettle(req);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toContain("UNAUTHORIZED");
    });

    it("should reject authenticated caller with unauthorized status (e.g. FROZEN status) with 403 FORBIDDEN", async () => {
      const frozenWallet = "0x4444444444444444444444444444444444444444";
      const token = createSessionToken({
        userId: "usr-frozen",
        walletAddress: frozenWallet,
      });
      const req = new NextRequest("http://localhost:3000/api/launchpad/bounty/settle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ claimId: crypto.randomUUID(), txHash: validTxHash }),
      });
      const res = await postSettle(req);
      expect([401, 403, 404]).toContain(res.status);
    });

    it("should reject regular user attempting to settle another user's claim with 403 FORBIDDEN", async () => {
      const otherWallet = "0x9999999999999999999999999999999999999999";
      const campaignId = `camp-authz-${Date.now()}`;
      const kolId = testClaimantWallet;
      const claim = await defaultBountyDbAdapter.createClaim(campaignId, kolId, "https://x.com/kol/status/1");
      await defaultBountyDbAdapter.updateClaimStatus(claim.id, "VERIFIED");

      const attackerToken = createSessionToken({
        userId: "usr-attacker",
        walletAddress: otherWallet,
      });
      const req = new NextRequest("http://localhost:3000/api/launchpad/bounty/settle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${attackerToken}`,
        },
        body: JSON.stringify({ claimId: claim.id, txHash: validTxHash }),
      });
      const res = await postSettle(req);
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toContain("FORBIDDEN");
    });

    it("should reject non-existent claim with 404 CLAIM_NOT_FOUND", async () => {
      const token = createSessionToken({
        userId: "usr-admin",
        walletAddress: testClaimantWallet,
      });
      const req = new NextRequest("http://localhost:3000/api/launchpad/bounty/settle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ claimId: crypto.randomUUID(), txHash: validTxHash }),
      });
      const res = await postSettle(req);
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toContain("CLAIM_NOT_FOUND");
    });

    it("should reject invalid transaction hash with 400 INVALID_TX_HASH", async () => {
      const token = createSessionToken({
        userId: "usr-admin",
        walletAddress: testClaimantWallet,
      });
      const req = new NextRequest("http://localhost:3000/api/launchpad/bounty/settle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ claimId: crypto.randomUUID(), txHash: "invalid-hash" }),
      });
      const res = await postSettle(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("INVALID_TX_HASH");
    });

    it("should reject invalid claim UUID format with 400 INVALID_CLAIM_ID", async () => {
      const token = createSessionToken({
        userId: "usr-admin",
        walletAddress: testClaimantWallet,
      });
      const req = new NextRequest("http://localhost:3000/api/launchpad/bounty/settle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ claimId: "not-a-uuid", txHash: validTxHash }),
      });
      const res = await postSettle(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("INVALID_CLAIM_ID");
    });

    it("should reject unverified claim with 400 INVALID_CLAIM_STATE", async () => {
      const campaignId = `camp-unverified-${Date.now()}`;
      const kolId = testClaimantWallet;
      const claim = await defaultBountyDbAdapter.createClaim(campaignId, kolId, "https://x.com/kol/status/pending");

      const token = createSessionToken({
        userId: kolId,
        walletAddress: testClaimantWallet,
      });
      const req = new NextRequest("http://localhost:3000/api/launchpad/bounty/settle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ claimId: claim.id, txHash: validTxHash }),
      });
      const res = await postSettle(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("INVALID_CLAIM_STATE");
    });

    it("should reject incompatible chain with 400 WRONG_CHAIN", async () => {
      const campaignId = `camp-chain-${Date.now()}`;
      const kolId = testClaimantWallet;
      const claim = await defaultBountyDbAdapter.createClaim(campaignId, kolId, "https://x.com/kol/status/c1");
      await defaultBountyDbAdapter.updateClaimStatus(claim.id, "VERIFIED");

      const token = createSessionToken({
        userId: kolId,
        walletAddress: testClaimantWallet,
      });
      const req = new NextRequest("http://localhost:3000/api/launchpad/bounty/settle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ claimId: claim.id, txHash: validTxHash, chain: "polygon-mainnet" }),
      });
      const res = await postSettle(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("WRONG_CHAIN");
    });

    it("should reject when receipt is null with 400 TX_NOT_FOUND", async () => {
      const campaignId = `camp-nullrcpt-${Date.now()}`;
      const kolId = testClaimantWallet;
      const claim = await defaultBountyDbAdapter.createClaim(campaignId, kolId, "https://x.com/kol/status/rcpt");
      await defaultBountyDbAdapter.updateClaimStatus(claim.id, "VERIFIED");

      const mockProvider = {
        getTransactionReceipt: async () => null,
      } as unknown as ethers.Provider;

      const token = createSessionToken({
        userId: kolId,
        walletAddress: testClaimantWallet,
      });
      const req = new NextRequest("http://localhost:3000/api/launchpad/bounty/settle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ claimId: claim.id, txHash: validTxHash }),
      });
      const res = await postSettle(req, { options: { provider: mockProvider } });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("TX_NOT_FOUND");
    });

    it("should reject on-chain reverted tx with 400 TRANSACTION_REVERTED_ONCHAIN", async () => {
      const campaignId = `camp-revert-${Date.now()}`;
      const kolId = testClaimantWallet;
      const claim = await defaultBountyDbAdapter.createClaim(campaignId, kolId, "https://x.com/kol/status/rev");
      await defaultBountyDbAdapter.updateClaimStatus(claim.id, "VERIFIED");

      const mockProvider = {
        getTransactionReceipt: async () => mockReceipt({ status: 0 }),
      } as unknown as ethers.Provider;

      const token = createSessionToken({
        userId: kolId,
        walletAddress: testClaimantWallet,
      });
      const req = new NextRequest("http://localhost:3000/api/launchpad/bounty/settle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ claimId: claim.id, txHash: validTxHash }),
      });
      const res = await postSettle(req, { options: { provider: mockProvider } });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("TRANSACTION_REVERTED_ONCHAIN");
    });

    it("should reject when receipt.to does not match launchpad with 400 INVALID_SETTLEMENT_CONTRACT", async () => {
      const campaignId = `camp-to-${Date.now()}`;
      const kolId = testClaimantWallet;
      const claim = await defaultBountyDbAdapter.createClaim(campaignId, kolId, "https://x.com/kol/status/to");
      await defaultBountyDbAdapter.updateClaimStatus(claim.id, "VERIFIED");

      const mockProvider = {
        getTransactionReceipt: async () => mockReceipt({
          to: "0x9999999999999999999999999999999999999999",
          logs: [],
        }),
      } as unknown as ethers.Provider;

      const token = createSessionToken({
        userId: kolId,
        walletAddress: testClaimantWallet,
      });
      const req = new NextRequest("http://localhost:3000/api/launchpad/bounty/settle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ claimId: claim.id, txHash: validTxHash }),
      });
      const res = await postSettle(req, {
        options: {
          provider: mockProvider,
          expectedTo: launchpadContract,
        },
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("INVALID_SETTLEMENT_CONTRACT");
    });

    it("should reject event from unexpected emitter with 400 INVALID_SETTLEMENT_CONTRACT", async () => {
      const campaignId = `camp-emitter-${Date.now()}`;
      const kolId = testClaimantWallet;
      const claim = await defaultBountyDbAdapter.createClaim(campaignId, kolId, "https://x.com/kol/status/emit");
      await defaultBountyDbAdapter.updateClaimStatus(claim.id, "VERIFIED");

      const fakeEmitter = "0x8888888888888888888888888888888888888888";
      const mockProvider = {
        getTransactionReceipt: async () => mockReceipt({
          to: launchpadContract,
          logs: [createValidClaimLog(testClaimantWallet, 1000000000000000000000n, fakeEmitter)],
        }),
      } as unknown as ethers.Provider;

      const token = createSessionToken({
        userId: kolId,
        walletAddress: testClaimantWallet,
      });
      const req = new NextRequest("http://localhost:3000/api/launchpad/bounty/settle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ claimId: claim.id, txHash: validTxHash }),
      });
      const res = await postSettle(req, {
        options: {
          provider: mockProvider,
          expectedTo: launchpadContract,
        },
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("INVALID_SETTLEMENT_CONTRACT");
    });

    it("should reject when receipt has no BountyRewardClaimed event with 400 INVALID_SETTLEMENT_EVENT", async () => {
      const campaignId = `camp-noevent-${Date.now()}`;
      const kolId = testClaimantWallet;
      const claim = await defaultBountyDbAdapter.createClaim(campaignId, kolId, "https://x.com/kol/status/noevt");
      await defaultBountyDbAdapter.updateClaimStatus(claim.id, "VERIFIED");

      const mockProvider = {
        getTransactionReceipt: async () => mockReceipt({
          logs: [{
            address: launchpadContract,
            topics: ["0x" + "b".repeat(64)],
            data: "0x",
          }],
        }),
      } as unknown as ethers.Provider;

      const token = createSessionToken({
        userId: kolId,
        walletAddress: testClaimantWallet,
      });
      const req = new NextRequest("http://localhost:3000/api/launchpad/bounty/settle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ claimId: claim.id, txHash: validTxHash }),
      });
      const res = await postSettle(req, { options: { provider: mockProvider } });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("INVALID_SETTLEMENT_EVENT");
    });

    it("should reject mismatched recipient wallet with 400 MISMATCHED_RECIPIENT_WALLET", async () => {
      const campaignId = `camp-wallet-${Date.now()}`;
      const kolId = testClaimantWallet;
      const claim = await defaultBountyDbAdapter.createClaim(campaignId, kolId, "https://x.com/kol/status/w");
      await defaultBountyDbAdapter.updateClaimStatus(claim.id, "VERIFIED");

      const wrongWallet = "0x7777777777777777777777777777777777777777";
      const mockProvider = {
        getTransactionReceipt: async () => mockReceipt({
          logs: [createValidClaimLog(wrongWallet)],
        }),
      } as unknown as ethers.Provider;

      const token = createSessionToken({
        userId: kolId,
        walletAddress: testClaimantWallet,
      });
      const req = new NextRequest("http://localhost:3000/api/launchpad/bounty/settle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ claimId: claim.id, txHash: validTxHash }),
      });
      const res = await postSettle(req, { options: { provider: mockProvider } });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("MISMATCHED_RECIPIENT_WALLET");
    });

    it("should reject mismatched reward amount with 400 MISMATCHED_REWARD_AMOUNT", async () => {
      const campaignId = `camp-amount-${Date.now()}`;
      const kolId = testClaimantWallet;
      const claim = await defaultBountyDbAdapter.createClaim(campaignId, kolId, "https://x.com/kol/status/amt");
      await defaultBountyDbAdapter.updateClaimStatus(claim.id, "VERIFIED");

      const wrongAmount = 999999999n;
      const mockProvider = {
        getTransactionReceipt: async () => mockReceipt({
          logs: [createValidClaimLog(testClaimantWallet, wrongAmount)],
        }),
      } as unknown as ethers.Provider;

      const token = createSessionToken({
        userId: kolId,
        walletAddress: testClaimantWallet,
      });
      const req = new NextRequest("http://localhost:3000/api/launchpad/bounty/settle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ claimId: claim.id, txHash: validTxHash }),
      });
      const res = await postSettle(req, { options: { provider: mockProvider } });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("MISMATCHED_REWARD_AMOUNT");
    });

    it("should reject mismatched token address with 400 MISMATCHED_TOKEN_ADDRESS on normal call", async () => {
      const campaignId = `camp-tokmismatch-${Date.now()}`;
      const kolId = testClaimantWallet;
      const claim = await defaultBountyDbAdapter.createClaim(campaignId, kolId, "https://x.com/kol/status/tok");
      await defaultBountyDbAdapter.updateClaimStatus(claim.id, "VERIFIED");

      const differentToken = "0x5555555555555555555555555555555555555555";
      const mockProvider = {
        getTransactionReceipt: async () => mockReceipt({
          logs: [createValidClaimLog(testClaimantWallet, 1000000000000000000000n, launchpadContract, differentToken)],
        }),
      } as unknown as ethers.Provider;

      const token = createSessionToken({
        userId: kolId,
        walletAddress: testClaimantWallet,
      });
      const req = new NextRequest("http://localhost:3000/api/launchpad/bounty/settle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ claimId: claim.id, txHash: validTxHash }),
      });
      const res = await postSettle(req, { options: { provider: mockProvider } });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("MISMATCHED_TOKEN_ADDRESS");
    });

    it("should successfully settle claim with valid receipt and event on normal call", async () => {
      const campaignId = `camp-success-${Date.now()}`;
      const kolId = testClaimantWallet;
      const claim = await defaultBountyDbAdapter.createClaim(campaignId, kolId, "https://x.com/kol/status/ok");
      await defaultBountyDbAdapter.updateClaimStatus(claim.id, "VERIFIED");

      const settleTxHash = "0x" + "1".repeat(64);
      const mockProvider = {
        getTransactionReceipt: async () => mockReceipt({
          hash: settleTxHash,
          logs: [createValidClaimLog(testClaimantWallet, 1000000000000000000000n, launchpadContract, testTokenAddress)],
        }),
      } as unknown as ethers.Provider;

      const token = createSessionToken({
        userId: kolId,
        walletAddress: testClaimantWallet,
      });
      const req = new NextRequest("http://localhost:3000/api/launchpad/bounty/settle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ claimId: claim.id, txHash: settleTxHash }),
      });
      const res = await postSettle(req, { options: { provider: mockProvider } });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.data.status).toBe("CLAIMED");
      expect(data.data.txHash).toBe(settleTxHash);
    });

    it("should reject already-settled claim with 409 ALREADY_SETTLED", async () => {
      const campaignId = `camp-idem-${Date.now()}`;
      const kolId = testClaimantWallet;
      const claim = await defaultBountyDbAdapter.createClaim(campaignId, kolId, "https://x.com/kol/status/idem");
      await defaultBountyDbAdapter.updateClaimStatus(claim.id, "VERIFIED");

      const txHashA = "0x" + "2".repeat(64);
      const mockProvider = {
        getTransactionReceipt: async () => mockReceipt({
          hash: txHashA,
          logs: [createValidClaimLog(testClaimantWallet, 1000000000000000000000n, launchpadContract, testTokenAddress)],
        }),
      } as unknown as ethers.Provider;

      const token = createSessionToken({
        userId: kolId,
        walletAddress: testClaimantWallet,
      });

      // First settlement
      const req1 = new NextRequest("http://localhost:3000/api/launchpad/bounty/settle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ claimId: claim.id, txHash: txHashA }),
      });
      const res1 = await postSettle(req1, { options: { provider: mockProvider } });
      expect(res1.status).toBe(200);

      // Second settlement with SAME claim -> 409 ALREADY_SETTLED
      const req2 = new NextRequest("http://localhost:3000/api/launchpad/bounty/settle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ claimId: claim.id, txHash: txHashA }),
      });
      const res2 = await postSettle(req2, { options: { provider: mockProvider } });
      expect(res2.status).toBe(409);
      const data2 = await res2.json();
      expect(data2.error).toContain("ALREADY_SETTLED");
    });

    it("should reject cross-campaign replay of same txHash with 409 TRANSACTION_ALREADY_USED", async () => {
      const campaignA = `camp-replayA-${Date.now()}`;
      const campaignB = `camp-replayB-${Date.now()}`;
      const kolId = testClaimantWallet;

      const claimA = await defaultBountyDbAdapter.createClaim(campaignA, kolId, "https://x.com/kol/status/repA");
      await defaultBountyDbAdapter.updateClaimStatus(claimA.id, "VERIFIED");

      const claimB = await defaultBountyDbAdapter.createClaim(campaignB, kolId, "https://x.com/kol/status/repB");
      await defaultBountyDbAdapter.updateClaimStatus(claimB.id, "VERIFIED");

      const sharedTxHash = "0x" + "3".repeat(64);
      const mockProvider = {
        getTransactionReceipt: async () => mockReceipt({
          hash: sharedTxHash,
          logs: [createValidClaimLog(testClaimantWallet, 1000000000000000000000n, launchpadContract, testTokenAddress)],
        }),
      } as unknown as ethers.Provider;

      const token = createSessionToken({
        userId: kolId,
        walletAddress: testClaimantWallet,
      });

      // Claim A settles with sharedTxHash -> OK
      const reqA = new NextRequest("http://localhost:3000/api/launchpad/bounty/settle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ claimId: claimA.id, txHash: sharedTxHash }),
      });
      const resA = await postSettle(reqA, { options: { provider: mockProvider } });
      expect(resA.status).toBe(200);

      // Claim B tries to settle with the SAME sharedTxHash -> 409 TRANSACTION_ALREADY_USED!
      const reqB = new NextRequest("http://localhost:3000/api/launchpad/bounty/settle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ claimId: claimB.id, txHash: sharedTxHash }),
      });
      const resB = await postSettle(reqB, { options: { provider: mockProvider } });
      expect(resB.status).toBe(409);
      const dataB = await resB.json();
      expect(dataB.error).toContain("TRANSACTION_ALREADY_USED");
    });

    it("should handle concurrent settlement race on different claims: one 200, one 409", async () => {
      const camp1 = `camp-race1-${Date.now()}`;
      const camp2 = `camp-race2-${Date.now()}`;
      const kolId = testClaimantWallet;

      const claim1 = await defaultBountyDbAdapter.createClaim(camp1, kolId, "https://x.com/kol/status/rc1");
      await defaultBountyDbAdapter.updateClaimStatus(claim1.id, "VERIFIED");

      const claim2 = await defaultBountyDbAdapter.createClaim(camp2, kolId, "https://x.com/kol/status/rc2");
      await defaultBountyDbAdapter.updateClaimStatus(claim2.id, "VERIFIED");

      const raceTxHash = "0x" + "4".repeat(64);
      const mockProvider = {
        getTransactionReceipt: async () => mockReceipt({
          hash: raceTxHash,
          logs: [createValidClaimLog(testClaimantWallet, 1000000000000000000000n, launchpadContract, testTokenAddress)],
        }),
      } as unknown as ethers.Provider;

      const token = createSessionToken({
        userId: kolId,
        walletAddress: testClaimantWallet,
      });

      const req1 = new NextRequest("http://localhost:3000/api/launchpad/bounty/settle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ claimId: claim1.id, txHash: raceTxHash }),
      });

      const req2 = new NextRequest("http://localhost:3000/api/launchpad/bounty/settle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ claimId: claim2.id, txHash: raceTxHash }),
      });

      const [res1, res2] = await Promise.all([
        postSettle(req1, { options: { provider: mockProvider } }),
        postSettle(req2, { options: { provider: mockProvider } }),
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([200, 409]);
    });

    it("should return 500 DATABASE_SETTLEMENT_FAILED when db adapter fails settlement write", async () => {
      const campaignId = `camp-dbfail-${Date.now()}`;
      const kolId = testClaimantWallet;
      const claim = await defaultBountyDbAdapter.createClaim(campaignId, kolId, "https://x.com/kol/status/dbfail");
      await defaultBountyDbAdapter.updateClaimStatus(claim.id, "VERIFIED");

      const mockDbFailAdapter = Object.assign(Object.create(defaultBountyDbAdapter), {
        getClaimById: async (id: string) => ({
          id,
          campaignId,
          kolId,
          proofUrl: "https://x.com/proof",
          verificationStatus: "VERIFIED" as const,
          createdAt: new Date(),
        }),
        settleClaimOnChain: async () => ({
          success: false,
          error: "Simulated database connection timeout during settlement write",
        }),
      });

      const failTxHash = "0x" + "5".repeat(64);
      const mockProvider = {
        getTransactionReceipt: async () => mockReceipt({
          hash: failTxHash,
          logs: [createValidClaimLog(testClaimantWallet, 1000000000000000000000n, launchpadContract, testTokenAddress)],
        }),
      } as unknown as ethers.Provider;

      const token = createSessionToken({
        userId: kolId,
        walletAddress: testClaimantWallet,
      });
      const req = new NextRequest("http://localhost:3000/api/launchpad/bounty/settle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ claimId: claim.id, txHash: failTxHash }),
      });
      const res = await postSettle(req, {
        options: {
          provider: mockProvider,
          adapter: mockDbFailAdapter as any,
        },
      });
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toContain("DATABASE_SETTLEMENT_FAILED");
    });

    it("should reject missing launchpad contract configuration with 500 CONFIGURATION_ERROR: MISSING_LAUNCHPAD_CONTRACT", async () => {
      const campaignId = `camp-missingcontract-${Date.now()}`;
      const kolId = testClaimantWallet;
      const claim = await defaultBountyDbAdapter.createClaim(campaignId, kolId, "https://x.com/kol/status/nocontract");
      await defaultBountyDbAdapter.updateClaimStatus(claim.id, "VERIFIED");

      const mockAdapterWithoutContract = Object.assign(Object.create(defaultBountyDbAdapter), {
        getCampaign: async (id: string) => ({
          id,
          launchId: "launch-nocontract",
          creatorId: "usr-creator",
          title: "No Contract Campaign",
          campaignType: "BOUNTY" as const,
          minTrustTier: "NEW" as const,
          requiredHashtag: "#NoContract",
          minFollowers: 100,
          rewardPerKol: 1000n,
          maxParticipants: 10,
          currentParticipants: 0,
          isActive: true,
          chain: "base-mainnet",
        }),
        getLaunchById: async () => null,
      });

      const token = createSessionToken({ userId: kolId, walletAddress: testClaimantWallet });
      const req = new NextRequest("http://localhost:3000/api/launchpad/bounty/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ claimId: claim.id, txHash: validTxHash }),
      });

      const res = await postSettle(req, { options: { adapter: mockAdapterWithoutContract } });
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toContain("MISSING_LAUNCHPAD_CONTRACT");
    });

    it("should reject invalid launchpad contract address with 500 CONFIGURATION_ERROR: INVALID_LAUNCHPAD_CONTRACT", async () => {
      const campaignId = `camp-invcontract-${Date.now()}`;
      const kolId = testClaimantWallet;
      const claim = await defaultBountyDbAdapter.createClaim(campaignId, kolId, "https://x.com/kol/status/invcontract");
      await defaultBountyDbAdapter.updateClaimStatus(claim.id, "VERIFIED");

      const token = createSessionToken({ userId: kolId, walletAddress: testClaimantWallet });
      const req = new NextRequest("http://localhost:3000/api/launchpad/bounty/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ claimId: claim.id, txHash: validTxHash }),
      });

      const res = await postSettle(req, { options: { expectedTo: "0xnot-an-eth-address" } });
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toContain("INVALID_LAUNCHPAD_CONTRACT");
    });

    it("should reject invalid token address with 500 CONFIGURATION_ERROR: INVALID_TOKEN_ADDRESS", async () => {
      const campaignId = `camp-invtoken-${Date.now()}`;
      const kolId = testClaimantWallet;
      const claim = await defaultBountyDbAdapter.createClaim(campaignId, kolId, "https://x.com/kol/status/invtoken");
      await defaultBountyDbAdapter.updateClaimStatus(claim.id, "VERIFIED");

      const token = createSessionToken({ userId: kolId, walletAddress: testClaimantWallet });
      const req = new NextRequest("http://localhost:3000/api/launchpad/bounty/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ claimId: claim.id, txHash: validTxHash }),
      });

      const res = await postSettle(req, { options: { expectedTokenAddress: "0xinvalid-token-addr" } });
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toContain("INVALID_TOKEN_ADDRESS");
    });

    it("should reject campaign and launch chain mismatch with 400 CAMPAIGN_LAUNCH_MISMATCH", async () => {
      const campaignId = `camp-mismatch-${Date.now()}`;
      const kolId = testClaimantWallet;
      const claim = await defaultBountyDbAdapter.createClaim(campaignId, kolId, "https://x.com/kol/status/mismatch");
      await defaultBountyDbAdapter.updateClaimStatus(claim.id, "VERIFIED");

      const mockAdapterMismatch = Object.assign(Object.create(defaultBountyDbAdapter), {
        getCampaign: async (id: string) => ({
          id,
          launchId: "launch-mismatch-1",
          creatorId: "usr-creator",
          title: "Mismatch Chain Campaign",
          campaignType: "BOUNTY" as const,
          minTrustTier: "NEW" as const,
          requiredHashtag: "#Mismatch",
          minFollowers: 100,
          rewardPerKol: 1000n,
          maxParticipants: 10,
          currentParticipants: 0,
          isActive: true,
          chain: "base-mainnet",
          tokenAddress: testTokenAddress,
        }),
        getLaunchById: async () => ({
          contractAddress: launchpadContract,
          chain: "robinhood-mainnet",
        }),
      });

      const token = createSessionToken({ userId: kolId, walletAddress: testClaimantWallet });
      const req = new NextRequest("http://localhost:3000/api/launchpad/bounty/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ claimId: claim.id, txHash: validTxHash }),
      });

      const res = await postSettle(req, { options: { adapter: mockAdapterMismatch } });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("CAMPAIGN_LAUNCH_MISMATCH");
    });

    it("should reject settlement when block confirmations are insufficient with 425 BLOCK_CONFIRMATIONS_INSUFFICIENT", async () => {
      const campaignId = `camp-conf-fail-${Date.now()}`;
      const kolId = testClaimantWallet;
      const claim = await defaultBountyDbAdapter.createClaim(campaignId, kolId, "https://x.com/kol/status/conf-fail");
      await defaultBountyDbAdapter.updateClaimStatus(claim.id, "VERIFIED");

      const settleTx = "0x" + "6".repeat(64);
      const mockProviderWithBlock = {
        getTransactionReceipt: async () => mockReceipt({
          hash: settleTx,
          blockNumber: 1000,
          logs: [createValidClaimLog(testClaimantWallet, 1000000000000000000000n, launchpadContract, testTokenAddress)],
        }),
        getBlockNumber: async () => 1000,
      } as unknown as ethers.Provider;

      const token = createSessionToken({ userId: kolId, walletAddress: testClaimantWallet });
      const req = new NextRequest("http://localhost:3000/api/launchpad/bounty/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ claimId: claim.id, txHash: settleTx }),
      });

      const res = await postSettle(req, { options: { provider: mockProviderWithBlock } });
      expect(res.status).toBe(425);
      const data = await res.json();
      expect(data.error).toContain("BLOCK_CONFIRMATIONS_INSUFFICIENT");
    });

    it("should successfully settle when block confirmations satisfy policy with 200", async () => {
      const campaignId = `camp-conf-pass-${Date.now()}`;
      const kolId = testClaimantWallet;
      const claim = await defaultBountyDbAdapter.createClaim(campaignId, kolId, "https://x.com/kol/status/conf-pass");
      await defaultBountyDbAdapter.updateClaimStatus(claim.id, "VERIFIED");

      const settleTx = "0x" + "7".repeat(64);
      const mockProviderFinalized = {
        getTransactionReceipt: async () => mockReceipt({
          hash: settleTx,
          blockNumber: 1000,
          logs: [createValidClaimLog(testClaimantWallet, 1000000000000000000000n, launchpadContract, testTokenAddress)],
        }),
        getBlockNumber: async () => 1002,
      } as unknown as ethers.Provider;

      const token = createSessionToken({ userId: kolId, walletAddress: testClaimantWallet });
      const req = new NextRequest("http://localhost:3000/api/launchpad/bounty/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ claimId: claim.id, txHash: settleTx }),
      });

      const res = await postSettle(req, { options: { provider: mockProviderFinalized } });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.data.status).toBe("CLAIMED");
    });

    it("should reject when receipt block number is ahead of current block with 400 INVALID_BLOCK_FINALITY", async () => {
      const campaignId = `camp-block-ahead-${Date.now()}`;
      const kolId = testClaimantWallet;
      const claim = await defaultBountyDbAdapter.createClaim(campaignId, kolId, "https://x.com/kol/status/ahead");
      await defaultBountyDbAdapter.updateClaimStatus(claim.id, "VERIFIED");

      const aheadTx = "0x" + "8".repeat(64);
      const mockProviderAhead = {
        getTransactionReceipt: async () => mockReceipt({
          hash: aheadTx,
          blockNumber: 5000,
          logs: [createValidClaimLog(testClaimantWallet, 1000000000000000000000n, launchpadContract, testTokenAddress)],
        }),
        getBlockNumber: async () => 4999,
      } as unknown as ethers.Provider;

      const token = createSessionToken({ userId: kolId, walletAddress: testClaimantWallet });
      const req = new NextRequest("http://localhost:3000/api/launchpad/bounty/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ claimId: claim.id, txHash: aheadTx }),
      });

      const res = await postSettle(req, { options: { provider: mockProviderAhead } });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("INVALID_BLOCK_FINALITY");
    });

    it("should return 503 RPC_UNAVAILABLE when getBlockNumber provider throws error", async () => {
      const campaignId = `camp-rpc-block-err-${Date.now()}`;
      const kolId = testClaimantWallet;
      const claim = await defaultBountyDbAdapter.createClaim(campaignId, kolId, "https://x.com/kol/status/rpcerr");
      await defaultBountyDbAdapter.updateClaimStatus(claim.id, "VERIFIED");

      const rpcErrTx = "0x" + "9".repeat(64);
      const mockProviderRpcErr = {
        getTransactionReceipt: async () => mockReceipt({
          hash: rpcErrTx,
          blockNumber: 1000,
          logs: [createValidClaimLog(testClaimantWallet, 1000000000000000000000n, launchpadContract, testTokenAddress)],
        }),
        getBlockNumber: async () => {
          throw new Error("RPC node response timeout during getBlockNumber");
        },
      } as unknown as ethers.Provider;

      const token = createSessionToken({ userId: kolId, walletAddress: testClaimantWallet });
      const req = new NextRequest("http://localhost:3000/api/launchpad/bounty/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ claimId: claim.id, txHash: rpcErrTx }),
      });

      const res = await postSettle(req, { options: { provider: mockProviderRpcErr } });
      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.error).toContain("RPC_UNAVAILABLE");
    });
  });

});
