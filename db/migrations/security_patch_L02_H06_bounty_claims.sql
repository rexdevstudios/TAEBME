-- ============================================================================
-- Migration: Security Patch L-02 + H-06 (bounty_claims)
-- Applied: 2026-09-24
-- Hardened: 2026-10-10 (Idempotent pg_constraint checks & pre-migration duplicate validation)
-- ============================================================================
--
-- SAFE MIGRATION INVARIANTS:
--   - Non-destructive: Does NOT drop, truncate, or delete rows.
--   - Pre-migration duplicate validation: Aborts with a descriptive exception
--     if duplicate (campaign_id, kol_id) or duplicate tx_hash are present.
--   - Idempotency: Uses pg_constraint checks inside DO $$ blocks so re-running
--     in any environment is safe and non-failing.
--   - tx_hash column is nullable — existing NULL rows are unaffected by the unique
--     constraint since NULL != NULL in Postgres.
-- ============================================================================

BEGIN;

-- 1. Pre-migration Duplicate Validation (Fail-closed without modifying data)
DO $$
DECLARE
  v_dup_campaign_kol_count INT := 0;
  v_dup_tx_hash_count INT := 0;
BEGIN
  -- Check for existing table before querying
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'bounty_claims') THEN
    -- Check duplicate (campaign_id, kol_id) pairs
    SELECT COUNT(*) INTO v_dup_campaign_kol_count
    FROM (
      SELECT campaign_id, kol_id
      FROM bounty_claims
      GROUP BY campaign_id, kol_id
      HAVING COUNT(*) > 1
    ) sub;

    IF v_dup_campaign_kol_count > 0 THEN
      RAISE EXCEPTION 'PRE_MIGRATION_VALIDATION_FAILED: Found % duplicate (campaign_id, kol_id) records in bounty_claims. Manual deduplication required before applying uq_bounty_claims_campaign_kol.', v_dup_campaign_kol_count;
    END IF;

    -- Check duplicate tx_hash values (excluding NULL)
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'bounty_claims' AND column_name = 'tx_hash'
    ) THEN
      SELECT COUNT(*) INTO v_dup_tx_hash_count
      FROM (
        SELECT tx_hash
        FROM bounty_claims
        WHERE tx_hash IS NOT NULL
        GROUP BY tx_hash
        HAVING COUNT(*) > 1
      ) sub;

      IF v_dup_tx_hash_count > 0 THEN
        RAISE EXCEPTION 'PRE_MIGRATION_VALIDATION_FAILED: Found % duplicate tx_hash records in bounty_claims. Manual deduplication required before applying uq_bounty_claims_tx_hash.', v_dup_tx_hash_count;
      END IF;
    END IF;
  END IF;
END $$;

-- 2. H-06: On-chain settlement tx hash column (Idempotent)
ALTER TABLE bounty_claims
  ADD COLUMN IF NOT EXISTS tx_hash VARCHAR(66);

-- 3. L-02: One claim per KOL per campaign (Idempotent pg_constraint check)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_bounty_claims_campaign_kol'
  ) THEN
    ALTER TABLE bounty_claims
      ADD CONSTRAINT uq_bounty_claims_campaign_kol UNIQUE (campaign_id, kol_id);
  END IF;
END $$;

-- 4. H-06: Prevent double-settle attacks (Idempotent pg_constraint check)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_bounty_claims_tx_hash'
  ) THEN
    ALTER TABLE bounty_claims
      ADD CONSTRAINT uq_bounty_claims_tx_hash UNIQUE (tx_hash);
  END IF;
END $$;

COMMIT;
