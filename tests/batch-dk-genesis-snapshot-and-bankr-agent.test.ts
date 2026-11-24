/**
 * Unit Suite #78 — Phase DK:
 * Post-Genesis Pioneer Snapshot & Merkle Whitelist Exporter + Full Bankr Agent API Rail.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildGenesisMerkleWhitelist,
  serializeGenesisSnapshotToCsv,
  type GenesisSbtMintRecord,
} from '../packages/billing/genesis-sbt';
import {
  BANKR_AGENT_JOB_URL,
  BANKR_AGENT_PROMPT_URL,
  getBankrAgentJobStatus,
  submitBankrAgentPrompt,
  validateBankrAgentPromptInput,
} from '../packages/launchpad/bankr-client';
import { PostgresBillingDbAdapter } from '../packages/db/billing-repo';

describe('Phase DK — Genesis Pioneer Snapshot & Merkle Whitelist Exporter', () => {
  const sampleRecords: GenesisSbtMintRecord[] = [
    {
      serialNumber: 2,
      walletAddress: '0x2222222222222222222222222222222222222222',
      txHash: '0x' + '2'.repeat(64),
      chain: 'base-mainnet',
      referredBy: '0x1111111111111111111111111111111111111111',
      mintedAt: '2026-11-24T10:02:00.000Z',
    },
    {
      serialNumber: 1,
      walletAddress: '0x1111111111111111111111111111111111111111',
      txHash: '0x' + '1'.repeat(64),
      chain: 'base-mainnet',
      referredBy: null,
      mintedAt: '2026-11-24T10:01:00.000Z',
    },
    {
      serialNumber: 3,
      walletAddress: '0x3333333333333333333333333333333333333333',
      txHash: '0x' + '3'.repeat(64),
      chain: '=cmd|calc',
      referredBy: '0x1111111111111111111111111111111111111111',
      mintedAt: '2026-11-24T10:03:00.000Z',
    },
  ];

  test('buildGenesisMerkleWhitelist sorts by serialNumber and computes referral tiers & weights', () => {
    const wl = buildGenesisMerkleWhitelist(sampleRecords);
    expect(wl.length).toBe(3);
    expect(wl[0].serialNumber).toBe(1);
    expect(wl[0].referralsCount).toBe(2);
    expect(wl[0].tier).toBe('AMBASSADOR');
    expect(wl[0].allocationWeight).toBe(1.5);

    expect(wl[1].serialNumber).toBe(2);
    expect(wl[1].referralsCount).toBe(0);
    expect(wl[1].tier).toBe('PIONEER');
    expect(wl[1].allocationWeight).toBe(1);
  });

  test('serializeGenesisSnapshotToCsv neutralizes CSV formula injection payloads', () => {
    const csv = serializeGenesisSnapshotToCsv(sampleRecords);
    const lines = csv.split('\n');
    expect(lines[0]).toBe(
      'serial_number,wallet_address,tier,allocation_weight,referrals_count,chain,minted_at'
    );
    expect(lines.length).toBe(4);
    expect(lines[3]).toContain("'=cmd|calc");
  });

  test('PostgresBillingDbAdapter.getAllGenesisSbtRecords returns all minted records in memory mode', async () => {
    const adapter = new PostgresBillingDbAdapter();
    const res = await adapter.recordGenesisSbtMint({
      walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      txHash: '0x' + 'a'.repeat(64),
      chain: 'base-mainnet',
      referredBy: null,
    });
    expect(res.ok).toBe(true);
    const all = await adapter.getAllGenesisSbtRecords();
    expect(all.length).toBe(1);
    expect(all[0].serialNumber).toBe(1);
  });
});

describe('Phase DK — Bankr Agent API Rail & Safety Guards', () => {
  test('validateBankrAgentPromptInput enforces length and blocks private key / seed phrase leaks', () => {
    expect(validateBankrAgentPromptInput('  ').valid).toBe(false);
    expect(validateBankrAgentPromptInput('a'.repeat(1001)).errorCode).toBe('PROMPT_TOO_LONG');
    expect(
      validateBankrAgentPromptInput(`use private key 0x${'ab'.repeat(32)} to swap`).errorCode
    ).toBe('SENSITIVE_SECRET_DETECTED');
    expect(
      validateBankrAgentPromptInput('Here is my seed phrase: alpha beta gamma').errorCode
    ).toBe('SENSITIVE_SECRET_DETECTED');

    const ok = validateBankrAgentPromptInput('Swap 0.05 ETH to USDC on Base');
    expect(ok.valid).toBe(true);
    expect(ok.sanitizedPrompt).toBe('Swap 0.05 ETH to USDC on Base');
  });

  test('submitBankrAgentPrompt and getBankrAgentJobStatus fail closed without real API key', async () => {
    expect(BANKR_AGENT_PROMPT_URL).toBe('https://api.bankr.bot/agent/prompt');
    expect(BANKR_AGENT_JOB_URL).toBe('https://api.bankr.bot/agent/job');

    const prevKey = process.env.BANKR_API_KEY;
    process.env.BANKR_API_KEY = '';
    try {
      const submitRes = await submitBankrAgentPrompt({ prompt: 'Check Base ETH balance' });
      expect(submitRes.status).toBe('failed');
      expect(submitRes.message).toContain('BANKR_API_KEY');

      const badJob = await getBankrAgentJobStatus({ jobId: '../etc/passwd' });
      expect(badJob.status).toBe('failed');
      expect(badJob.message).toContain('INVALID_JOB_ID');

      const noKeyJob = await getBankrAgentJobStatus({ jobId: 'job_12345' });
      expect(noKeyJob.status).toBe('failed');
    } finally {
      if (prevKey !== undefined) process.env.BANKR_API_KEY = prevKey;
    }
  });

  test('Admin Genesis Snapshot route & Bankr Agent route enforce RBAC / SIWE / KillSwitch contracts', () => {
    const root = join(import.meta.dir, '..');
    const snapRoute = readFileSync(join(root, 'app/api/admin/genesis-snapshot/route.ts'), 'utf8');
    expect(snapRoute).toContain("requireCapability(req, 'MANAGE_BILLING_PLANS')");
    expect(snapRoute).toContain('serializeGenesisSnapshotToCsv');

    const bankrRoute = readFileSync(join(root, 'app/api/agent/bankr-prompt/route.ts'), 'utf8');
    expect(bankrRoute).toContain('requireActiveSession(req)');
    expect(bankrRoute).toContain('getActiveKillSwitches()');
    expect(bankrRoute).toContain('submitBankrAgentPrompt');
    expect(bankrRoute).toContain('getBankrAgentJobStatus');

    const billingPage = readFileSync(join(root, 'app/billing/page.tsx'), 'utf8');
    expect(billingPage).toContain('<AdminGenesisSnapshotPanel />');
  });
});
