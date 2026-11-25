/**
 * tests/batch-dw-kol-admin-queue-and-dataset-snapshot.test.ts
 *
 * Unit Suite #90 — Phase DW:
 *  - Explicit Admin revocation hard-veto in isVerifiedKol()
 *  - Deterministic Admin decision resolver (APPROVE_GOLD / APPROVE_SILVER / REVOKE)
 *  - Curated Anti-Manipulation KOL Consensus AI Dataset snapshot builder
 *  - OWASP CSV formula-injection neutralization in dataset CSV exporter
 *  - Admin RBAC route & UI wiring verification
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildCuratedKolDatasetSnapshot,
  computeAntiManipulationKolConsensus,
  isVerifiedKol,
  KOL_DATASET_GUARDRAILS_VERSION,
  resolveKolVerificationDecision,
  serializeKolConsensusDatasetToCsv,
} from '../packages/intelligence/kol-chart-overlay';

describe('Phase DW: Dedicated KOL Verification Admin Queue & AI Dataset Snapshot', () => {
  test('isVerifiedKol enforces explicit admin revocation hard-veto even with high trustScore', () => {
    const revoked = isVerifiedKol({
      walletAddress: '0x1111111111111111111111111111111111111111',
      twitterHandle: 'alpha_kol',
      trustScore: 95,
      isVerified: false,
    });
    expect(revoked.verified).toBe(false);
    expect(revoked.tier).toBe('UNVERIFIED');

    const active = isVerifiedKol({
      walletAddress: '0x1111111111111111111111111111111111111111',
      twitterHandle: 'alpha_kol',
      trustScore: 95,
      isVerified: true,
    });
    expect(active.verified).toBe(true);
    expect(active.tier).toBe('GOLD');

    // Backward compatibility when isVerified is omitted (undefined)
    const legacy = isVerifiedKol({
      walletAddress: '0x1111111111111111111111111111111111111111',
      twitterHandle: 'alpha_kol',
      trustScore: 72,
    });
    expect(legacy.verified).toBe(true);
    expect(legacy.tier).toBe('SILVER');
  });

  test('resolveKolVerificationDecision maps APPROVE_GOLD, APPROVE_SILVER, REVOKE and rejects invalid inputs', () => {
    expect(resolveKolVerificationDecision('approve_gold')).toEqual({
      decision: 'APPROVE_GOLD',
      isVerified: true,
      trustScore: 90,
      resultingTier: 'GOLD',
    });
    expect(resolveKolVerificationDecision('APPROVE_SILVER')).toEqual({
      decision: 'APPROVE_SILVER',
      isVerified: true,
      trustScore: 75,
      resultingTier: 'SILVER',
    });
    expect(resolveKolVerificationDecision('REVOKE')).toEqual({
      decision: 'REVOKE',
      isVerified: false,
      trustScore: 40,
      resultingTier: 'UNVERIFIED',
    });
    expect(resolveKolVerificationDecision('SELF_VERIFY')).toBeNull();
    expect(resolveKolVerificationDecision(null)).toBeNull();
  });

  test('buildCuratedKolDatasetSnapshot & CSV exporter neutralize OWASP formula injection', () => {
    const now = Date.now();
    const btcReport = computeAntiManipulationKolConsensus({
      tokenSymbol: 'BTCUSDT',
      nowMs: now,
      signals: [
        {
          walletAddress: '0x2222222222222222222222222222222222222222',
          handle: '@whale_gold',
          trustScore: 90,
          hasSocialProof: true,
          source: 'ONCHAIN_ENTRY',
          side: 'BUY',
          price: 92000,
          timestampMs: now - 60_000,
        },
      ],
    });

    const maliciousReport = {
      ...btcReport,
      tokenSymbol: '=CMD|calc',
      flags: ['+INJECTED_FLAG'],
    };

    const snapshot = buildCuratedKolDatasetSnapshot({
      reports: [btcReport, maliciousReport],
      generatedAt: '2026-11-25T12:00:00.000Z',
    });

    expect(snapshot.guardrailsVersion).toBe(KOL_DATASET_GUARDRAILS_VERSION);
    expect(snapshot.totalSymbols).toBe(2);
    expect(snapshot.activeConsensusSymbols).toBe(2);

    const csv = serializeKolConsensusDatasetToCsv(snapshot);
    expect(csv).toContain('generated_at,token_symbol,consensus_score,verdict');
    expect(csv).toContain('BTCUSDT');
    // Formula-injection cells must be prefixed with single quote (symbol normalized to uppercase)
    expect(csv).toContain("'=CMD|CALC");
    expect(csv).toContain("'+INJECTED_FLAG");
  });

  test('Admin routes enforce REVIEW_FLAGGED_TOKEN RBAC and panel is mounted on /billing', () => {
    const verifRoute = readFileSync(
      join(process.cwd(), 'app/api/admin/kol-verification/route.ts'),
      'utf8'
    );
    const datasetRoute = readFileSync(
      join(process.cwd(), 'app/api/admin/kol-dataset/route.ts'),
      'utf8'
    );
    const billingPage = readFileSync(join(process.cwd(), 'app/billing/page.tsx'), 'utf8');

    expect(verifRoute).toContain("requireCapability(req, 'REVIEW_FLAGGED_TOKEN')");
    expect(verifRoute).toContain('ADMIN_KOL_VERIFICATION_UPDATED');
    expect(datasetRoute).toContain("requireCapability(req, 'REVIEW_FLAGGED_TOKEN')");
    expect(datasetRoute).toContain('serializeKolConsensusDatasetToCsv');
    expect(billingPage).toContain('AdminKolVerificationPanel');
  });
});
