-- ============================================================================
-- Migration: Security Patch L-02 + H-06 (bounty_claims)
-- Applied: 2026-09-24
-- ============================================================================
--
-- SAFE MIGRATION CHECKLIST (run BEFORE this migration):
--   Check for existing duplicates:
--   SELECT campaign_id, kol_id, COUNT(*) FROM bounty_claims
--   GROUP BY campaign_id, kol_id HAVING COUNT(*) > 1;
--   Resolve any duplicates before proceeding.
--
-- tx_hash column is nullable — existing NULL rows are unaffected by the unique
-- constraint since NULL != NULL in Postgres.
-- ============================================================================

BEGIN;

-- L-02: One claim per KOL per campaign
ALTER TABLE bounty_claims
  ADD CONSTRAINT uq_bounty_claims_campaign_kol UNIQUE (campaign_id, kol_id);

-- H-06: On-chain settlement tx hash column
ALTER TABLE bounty_claims
  ADD COLUMN IF NOT EXISTS tx_hash VARCHAR(66);

-- H-06: Prevent double-settle attacks
ALTER TABLE bounty_claims
  ADD CONSTRAINT uq_bounty_claims_tx_hash UNIQUE (tx_hash);

COMMIT;
