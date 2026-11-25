/**
 * tests/batch-ee-copilot-paper-sim-highlights-and-e2e.test.ts
 *
 * Unit Suite #98 — Phase EE:
 *  - Built-in PAPER_SIM virtual account in Copilot engine & routes
 *  - Webhook notification wiring on multi-account confirm
 *  - Clickable Top Movers & KOL Consensus pills in AiCopilotChatPanel
 *  - Live Copilot E2E assertions registered in scripts/test-testnet-full-usecase.ts
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  COPILOT_PAPER_SIM_ACCOUNT,
  parseCopilotUserMessage,
} from '../packages/agent/copilot-engine';

describe('Phase EE: Copilot Paper Simulator Account, Live Highlights & E2E Wiring', () => {
  test('COPILOT_PAPER_SIM_ACCOUNT is supported for both LIMIT and MARKET CEX drafts (never Bankr)', () => {
    expect(COPILOT_PAPER_SIM_ACCOUNT.id).toBe('paper-sim-default');
    expect(COPILOT_PAPER_SIM_ACCOUNT.rail).toBe('PAPER_SIM');
    expect(COPILOT_PAPER_SIM_ACCOUNT.scope).toBe('PAPER');

    const limit = parseCopilotUserMessage('Buy limit ETH at 3000 for $100');
    expect(limit.actionDraft?.supportedRails).toContain('PAPER_SIM');

    const market = parseCopilotUserMessage('Buy SOL $50');
    expect(market.actionDraft?.supportedRails).toContain('PAPER_SIM');

    const bankr = parseCopilotUserMessage('Swap $50 USDC on Base via Bankr');
    expect(bankr.actionDraft?.supportedRails).toEqual(['BANKR']);
  });

  test('Copilot routes, UI panel, and Testnet E2E script wire PAPER_SIM, webhooks, and highlights', () => {
    const chatRoute = readFileSync(join(process.cwd(), 'app/api/agent/copilot/chat/route.ts'), 'utf8');
    const confirmRoute = readFileSync(join(process.cwd(), 'app/api/agent/copilot/confirm/route.ts'), 'utf8');
    const panel = readFileSync(join(process.cwd(), 'app/components/AiCopilotChatPanel.tsx'), 'utf8');
    const e2eScript = readFileSync(join(process.cwd(), 'scripts/test-testnet-full-usecase.ts'), 'utf8');

    expect(chatRoute).toContain('COPILOT_PAPER_SIM_ACCOUNT');
    expect(confirmRoute).toContain('PAPER_SIM');
    expect(confirmRoute).toContain('notifyUserWebhookBestEffort');
    expect(panel).toContain('liveHighlights');
    expect(panel).toContain('KOL VERIFIED:');
    expect(e2eScript).toContain('/api/agent/copilot/chat');
    expect(e2eScript).toContain('/api/agent/copilot/confirm');
  });
});
