import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildDeterministicCopilotReply,
  parseCopilotUserMessage,
  validateOwnedWalletTransferPrompt,
} from '../packages/agent/copilot-engine';

const OWNED_WALLET = '0x1111111111111111111111111111111111111111';
const FOREIGN_WALLET = '0x000000000000000000000000000000000000dead';

describe('Phase EF — Owned-Wallet Transfer Allowlist Guard, Pending Intent Cancel & Persistent Copilot', () => {
  test('allows non-transfer prompts untouched', () => {
    const res = validateOwnedWalletTransferPrompt('Swap $25 USDC to ETH on Base via Bankr', [OWNED_WALLET]);
    expect(res.isTransferCommand).toBe(false);
    expect(res.allowed).toBe(true);
  });

  test('hard-blocks external/unregistered 0x transfer destinations (Zone 2)', () => {
    const res = validateOwnedWalletTransferPrompt(
      `Transfer 100 USDC to ${FOREIGN_WALLET}`,
      [OWNED_WALLET]
    );
    expect(res.isTransferCommand).toBe(true);
    expect(res.allowed).toBe(false);
    expect(res.code).toBe('TRANSFER_DESTINATION_NOT_WHITELISTED');
    expect(res.blockedAddress?.toLowerCase()).toBe(FOREIGN_WALLET);
  });

  test('requires explicit destination or own-wallet alias on transfer commands', () => {
    const res = validateOwnedWalletTransferPrompt('Kirim 50 USDC sekarang', [OWNED_WALLET]);
    expect(res.isTransferCommand).toBe(true);
    expect(res.allowed).toBe(false);
    expect(res.code).toBe('TRANSFER_DESTINATION_REQUIRED');
  });

  test('allows verified owned wallet transfer via explicit address or "wallet saya" alias (Zone 1)', () => {
    const explicitRes = validateOwnedWalletTransferPrompt(
      `Kirim 50 USDC ke ${OWNED_WALLET}`,
      [OWNED_WALLET]
    );
    expect(explicitRes.isTransferCommand).toBe(true);
    expect(explicitRes.allowed).toBe(true);
    expect(explicitRes.verifiedDestination).toBe(OWNED_WALLET);

    const aliasRes = validateOwnedWalletTransferPrompt(
      'Transfer $40 USDC ke wallet saya',
      [OWNED_WALLET]
    );
    expect(aliasRes.isTransferCommand).toBe(true);
    expect(aliasRes.allowed).toBe(true);
    expect(aliasRes.verifiedDestination).toBe(OWNED_WALLET);
  });

  test('parses TRANSFER_OWNED intent and builds verified owned-wallet reply', () => {
    const parsed = parseCopilotUserMessage(`Kirim $75 USDC ke ${OWNED_WALLET}`);
    expect(parsed.valid).toBe(true);
    expect(parsed.kind).toBe('TRANSFER_OWNED');
    expect(parsed.actionDraft?.kind).toBe('TRANSFER_OWNED');
    expect(parsed.actionDraft?.verifiedDestination).toBe(OWNED_WALLET);
    expect(parsed.actionDraft?.supportedRails).toEqual(['BANKR']);

    const reply = buildDeterministicCopilotReply({
      locale: 'id',
      intent: parsed,
      tickers: {},
      topMovers: [],
      deployerTokens: [],
      accounts: [],
      kolConsensus: { score: 0, verdict: 'NO_VERIFIED_SIGNAL', uniqueVerifiedKols: 0 },
    });
    expect(reply).toContain('VERIFIED OWNED WALLET');
    expect(reply).toContain(OWNED_WALLET);
  });

  test('verifies defense-in-depth wiring in routes, db-pool cancel helper, and persistent UI drawer', () => {
    const bankrRoute = fs.readFileSync(
      path.join(process.cwd(), 'app/api/agent/bankr-prompt/route.ts'),
      'utf8'
    );
    const chatRoute = fs.readFileSync(
      path.join(process.cwd(), 'app/api/agent/copilot/chat/route.ts'),
      'utf8'
    );
    const confirmRoute = fs.readFileSync(
      path.join(process.cwd(), 'app/api/agent/copilot/confirm/route.ts'),
      'utf8'
    );
    const tradeIntentsRoute = fs.readFileSync(
      path.join(process.cwd(), 'app/api/trade-intents/route.ts'),
      'utf8'
    );
    const uiPanel = fs.readFileSync(
      path.join(process.cwd(), 'app/components/AiCopilotChatPanel.tsx'),
      'utf8'
    );

    expect(bankrRoute).toContain('validateOwnedWalletTransferPrompt');
    expect(chatRoute).toContain('validateOwnedWalletTransferPrompt');
    expect(chatRoute).toContain('railSummary');
    expect(confirmRoute).toContain('validateOwnedWalletTransferPrompt');
    expect(tradeIntentsRoute).toContain('export async function DELETE');
    expect(tradeIntentsRoute).toContain('cancelUserPendingTradeIntent');
    expect(uiPanel).toContain('COPILOT_HISTORY_STORAGE_KEY');
    expect(uiPanel).toContain('VERIFIED OWNED WALLET');
    expect(uiPanel).toContain('/api/trade-intents?tradeIntentId=');
  });
});
