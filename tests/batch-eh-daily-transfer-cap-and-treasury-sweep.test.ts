import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildDeployerFeeSweepPrompt,
  computeDailyTransferCapCheck,
  parseTransferredUsdFromAuditReasons,
} from '../packages/agent/copilot-engine';

describe('Phase EH — Per-User 24h Rolling Transfer Cap & 1-Click Deployer Fee Treasury Sweep', () => {
  test('approves transfer within remaining 24h rolling quota and computes updated remaining balance', () => {
    const res = computeDailyTransferCapCheck({
      requestedUsd: 150,
      used24hUsd: 200,
      dailyCapUsd: 500,
    });
    expect(res.ok).toBe(true);
    expect(res.remainingUsd).toBe(150);
  });

  test('blocks cumulative 24h transfers exceeding daily cap', () => {
    const res = computeDailyTransferCapCheck({
      requestedUsd: 200,
      used24hUsd: 350,
      dailyCapUsd: 500,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('TRANSFER_DAILY_CAP_EXCEEDED');
    expect(res.remainingUsd).toBe(150);
  });

  test('parses cumulative 24h transferred USD strictly from TRANSFER_OWNED audit reasons', () => {
    const total = parseTransferredUsdFromAuditReasons([
      'kind=TRANSFER_OWNED symbol=BTCUSDT accounts=1 totalUsd=75.5',
      'kind=CEX_LIMIT_ORDER symbol=BTCUSDT accounts=2 totalUsd=500',
      'kind=TRANSFER_OWNED symbol=ETHUSDT accounts=2 totalUsd=124.5',
    ]);
    expect(total).toBe(200);
  });

  test('builds deterministic bilingual deployer fee treasury sweep prompt', () => {
    const wallet = '0x1111111111111111111111111111111111111111';
    const idPrompt = buildDeployerFeeSweepPrompt({ destinationWallet: wallet, locale: 'id', estimatedEth: 0.125 });
    const enPrompt = buildDeployerFeeSweepPrompt({ destinationWallet: wallet, locale: 'en' });
    expect(idPrompt).toContain(wallet);
    expect(idPrompt).toContain('0.1250 ETH');
    expect(enPrompt).toContain(wallet);
    expect(enPrompt.toLowerCase()).toContain('transfer');
  });

  test('verifies per-user effective risk limits, 24h audit reader, and UI sweep button wiring', () => {
    const chatSrc = fs.readFileSync(
      path.join(process.cwd(), 'app/api/agent/copilot/chat/route.ts'),
      'utf8'
    );
    const confirmSrc = fs.readFileSync(
      path.join(process.cwd(), 'app/api/agent/copilot/confirm/route.ts'),
      'utf8'
    );
    const dbSrc = fs.readFileSync(
      path.join(process.cwd(), 'packages/shared/db-pool.ts'),
      'utf8'
    );
    const uiSrc = fs.readFileSync(
      path.join(process.cwd(), 'app/components/AiCopilotChatPanel.tsx'),
      'utf8'
    );

    expect(chatSrc).toContain('computeEffectiveUserRiskLimits');
    expect(chatSrc).toContain('getUser24hOwnedTransferUsd');
    expect(confirmSrc).toContain('computeEffectiveUserRiskLimits');
    expect(confirmSrc).toContain('computeDailyTransferCapCheck');
    expect(dbSrc).toContain('export async function getUser24hOwnedTransferUsd');
    expect(uiSrc).toContain('buildDeployerFeeSweepPrompt');
    expect(uiSrc).toContain('24h Quota:');
  });
});
