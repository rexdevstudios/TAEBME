// ============================================================================
// BATCH F1 + U1 CONTRACT & ISOLATION VERIFICATION TESTS
// ============================================================================
// Verifies:
// 1. LaunchDraftService.createDraft() returns UUID id (publish-compatible)
// 2. GET /api/launchpad/whitelist fails closed (no self-echo bypass)
// 3. packages/launchpad/evm-verifier.ts supports Base/Sepolia/Robinhood/Arbitrum/Arc
// ============================================================================

import { describe, it, expect } from 'bun:test';
import { NextRequest } from 'next/server';
import { LaunchDraftService } from '../packages/launchpad/launch-draft-service';
import { GET as whitelistGET } from '../app/api/launchpad/whitelist/route';
import {
  getEvmPublicClient,
  verifyEvmTransactionReceipt,
} from '../packages/launchpad/evm-verifier';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WALLET_A = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const WALLET_B = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const TOKEN_ADDR = '0x0000000000000000000000000000000000000002';

describe('Batch F1 + U1 — Contract & Vercel Isolation Verification', () => {
  it('F1-1: LaunchDraftService.createDraft() generates valid UUID id and canonical ticker/launchMode', async () => {
    const mockDb = {
      saveDraft: async (d: any) => d.id,
      saveWhitelist: async () => {},
      createAuditLog: async () => {},
    };
    const svc = new LaunchDraftService(mockDb);
    const draft = await svc.createDraft('usr-test', WALLET_A, {
      name: 'Alpha Moon',
      ticker: 'moon',
      description: 'test',
      imageUrl: '/token.png',
      launchMode: 'FAIR_LAUNCH',
      targetChain: 'base-mainnet',
      totalSupply: '1000000000',
      creatorAllocationPct: 0,
    });

    expect(draft.id).toMatch(UUID_REGEX);
    expect(draft.ticker).toBe('MOON');
    expect(draft.launchMode).toBe('FAIR_LAUNCH');
  });

  it('F1-2: GET /api/launchpad/whitelist fails closed when no whitelist exists (no self-echo)', async () => {
    const req = new NextRequest(
      `https://testnet.pndigi.site/api/launchpad/whitelist?tokenAddress=${TOKEN_ADDR}&walletAddress=${WALLET_A}`
    );
    const res = await whitelistGET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.isWhitelisted).toBe(false);
    expect(json.data.merkleProof).toEqual([]);
  });

  it('F1-3: GET /api/launchpad/whitelist returns true + proof when wallet is in explicit whitelist, false otherwise', async () => {
    const reqEligible = new NextRequest(
      `https://testnet.pndigi.site/api/launchpad/whitelist?tokenAddress=${TOKEN_ADDR}&walletAddress=${WALLET_A}&whitelist=${WALLET_A},${WALLET_B}`
    );
    const resEligible = await whitelistGET(reqEligible);
    const jsonEligible = await resEligible.json();
    expect(jsonEligible.data.isWhitelisted).toBe(true);
    expect(jsonEligible.data.merkleProof.length).toBeGreaterThan(0);

    const reqOther = new NextRequest(
      `https://testnet.pndigi.site/api/launchpad/whitelist?tokenAddress=${TOKEN_ADDR}&walletAddress=${WALLET_A}&whitelist=${WALLET_B}`
    );
    const resOther = await whitelistGET(reqOther);
    const jsonOther = await resOther.json();
    expect(jsonOther.data.isWhitelisted).toBe(false);
    expect(jsonOther.data.merkleProof).toEqual([]);
  });

  it('U1-1: packages/launchpad/evm-verifier resolves supported chains and rejects malformed txHash cleanly', async () => {
    expect(getEvmPublicClient('base-mainnet')).not.toBeNull();
    expect(getEvmPublicClient('base-sepolia')).not.toBeNull();
    expect(getEvmPublicClient('robinhood-mainnet')).not.toBeNull();
    expect(getEvmPublicClient('arbitrum-mainnet')).not.toBeNull();
    expect(getEvmPublicClient('arc-mainnet')).not.toBeNull();
    expect(getEvmPublicClient('unknown-chain')).toBeNull();

    const badHash = await verifyEvmTransactionReceipt('not-a-hash', 'base-mainnet');
    expect(badHash.status).toBe('error');
  });
});
