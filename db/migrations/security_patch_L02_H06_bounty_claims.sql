-- ============================================================================
-- Migration: Security Patch L-02 + H-06 (bounty_claims)
-- Applied: 2026-09-24
-- Hardened: 2026-10-10 (ARC-01 relation OID scoping; ARC-02 defensive catalog validation)
-- ============================================================================
--
-- SAFE MIGRATION INVARIANTS:
--   - Non-destructive: Does NOT drop, truncate, or delete rows.
--   - Target-Schema Safe: Enforces explicit operator schema (rtrader.target_schema).
--   - Bounded Lock: Acquires ACCESS EXCLUSIVE with 5s timeout to prevent TOCTOU.
--   - Post-Lock Invariant: Validates relation OID and table kind under exclusive lock.
--   - Strict Column Validation: Asserts uuid NOT NULL for (campaign_id, kol_id)
--     and nullable varchar(66) for tx_hash.
--   - Pre-migration duplicate validation: Aborts with a descriptive exception
--     if duplicate (campaign_id, kol_id) or duplicate tx_hash are present.
--   - Semantic Constraint Equivalence: Validates contype='u', ordered conkey,
--     condeferrable=false, condeferred=false, convalidated=true, and backing index.
--   - Backing-Index Lifecycle & Payload: Enforces indisvalid, indisready, indislive,
--     and zero non-key INCLUDE columns (indnkeyatts = indnatts).
--   - NULL Uniqueness: Version-aware check ensuring tx_hash enforces NULLS DISTINCT
--     (indnullsnotdistinct = false on PG 15+).
--   - Redundancy & Conflict Guard: Fails closed on equivalent standalone unique indexes
--     or same-name incompatible constraints.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- ============================================================================
-- Unified ARC-02 Defensive Migration Block (Single Atomic Scope)
-- ============================================================================
DO $$
DECLARE
  v_target_schema      text := current_setting('rtrader.target_schema', true);
  v_pg_version         int  := current_setting('server_version_num')::int;
  v_schema_oid         oid;
  v_pre_lock_oid       oid;
  v_rel_oid            oid;
  v_relkind            "char";
  v_attnum_camp        smallint;
  v_attnum_kol         smallint;
  v_attnum_tx          smallint;
  v_type_camp          text;
  v_type_kol           text;
  v_type_tx            text;
  v_notnull_camp       boolean;
  v_notnull_kol        boolean;
  v_notnull_tx         boolean;
  v_dup_count          int := 0;

  -- Constraint 1 (campaign_id, kol_id) variables
  v_con1_oid           oid;
  v_con1_type          "char";
  v_con1_key           smallint[];
  v_con1_deferrable    boolean;
  v_con1_deferred      boolean;
  v_con1_validated     boolean;
  v_con1_idx_valid     boolean;
  v_con1_idx_ready     boolean;
  v_con1_idx_live      boolean;
  v_con1_is_partial    boolean;
  v_con1_is_pure_keys  boolean;
  v_con1_no_include    boolean;
  v_con1_other_name    text;
  v_con1_stand_idx     text;
  v_con1_unhealthy_idx text;

  -- Constraint 2 (tx_hash) variables
  v_con2_oid           oid;
  v_con2_type          "char";
  v_con2_key           smallint[];
  v_con2_deferrable    boolean;
  v_con2_deferred      boolean;
  v_con2_validated     boolean;
  v_con2_idx_valid     boolean;
  v_con2_idx_ready     boolean;
  v_con2_idx_live      boolean;
  v_con2_is_partial    boolean;
  v_con2_is_pure_keys  boolean;
  v_con2_no_include    boolean;
  v_con2_nulls_not_dist boolean;
  v_con2_other_name    text;
  v_con2_stand_idx     text;
  v_con2_unhealthy_idx text;

  -- Dynamic SQL strings for PG version isolation
  v_query_con2         text;
  v_query_idx2         text;
BEGIN
  -- --------------------------------------------------------------------------
  -- 1. Explicit Schema Resolution & Pre-Lock Verification (Fail-Closed)
  -- --------------------------------------------------------------------------
  IF v_target_schema IS NULL OR trim(v_target_schema) = '' THEN
    RAISE EXCEPTION 'CONFIG_REQUIRED: Explicit target schema must be configured via SET rtrader.target_schema = ''<schema>'';';
  END IF;

  SELECT oid INTO v_schema_oid FROM pg_namespace WHERE nspname = v_target_schema;
  IF v_schema_oid IS NULL THEN
    RAISE EXCEPTION 'SCHEMA_RESOLUTION_FAILED: Configured schema "%" does not exist.', v_target_schema;
  END IF;

  SELECT oid INTO v_pre_lock_oid
  FROM pg_class
  WHERE relnamespace = v_schema_oid AND relname = 'bounty_claims' AND relkind = 'r';

  IF v_pre_lock_oid IS NULL THEN
    RAISE EXCEPTION 'RELATION_RESOLUTION_FAILED: Table "%.bounty_claims" does not exist as an ordinary table.', v_target_schema;
  END IF;

  -- --------------------------------------------------------------------------
  -- 2. Fully Schema-Qualified Lock & Identity Invariant Revalidation
  -- --------------------------------------------------------------------------
  EXECUTE format('LOCK TABLE %I.%I IN ACCESS EXCLUSIVE MODE', v_target_schema, 'bounty_claims');

  SELECT oid, relkind INTO v_rel_oid, v_relkind
  FROM pg_class
  WHERE relnamespace = v_schema_oid AND relname = 'bounty_claims';

  IF v_rel_oid IS NULL OR v_rel_oid <> v_pre_lock_oid OR v_relkind <> 'r' THEN
    RAISE EXCEPTION 'RELATION_IDENTITY_MISMATCH: Table "%.bounty_claims" OID or type changed during lock acquisition. Expected OID %, found %. Fail-closed.',
      v_target_schema, v_pre_lock_oid, v_rel_oid;
  END IF;

  -- --------------------------------------------------------------------------
  -- 3. Column Existence, Types & Strict Nullability Validations
  -- --------------------------------------------------------------------------
  SELECT attnum, format_type(atttypid, atttypmod), attnotnull
  INTO v_attnum_camp, v_type_camp, v_notnull_camp
  FROM pg_attribute WHERE attrelid = v_rel_oid AND attname = 'campaign_id' AND NOT attisdropped;

  SELECT attnum, format_type(atttypid, atttypmod), attnotnull
  INTO v_attnum_kol, v_type_kol, v_notnull_kol
  FROM pg_attribute WHERE attrelid = v_rel_oid AND attname = 'kol_id' AND NOT attisdropped;

  IF v_attnum_camp IS NULL OR v_attnum_kol IS NULL THEN
    RAISE EXCEPTION 'COLUMN_VALIDATION_FAILED: Columns (campaign_id, kol_id) missing on %.bounty_claims.', v_target_schema;
  END IF;

  IF v_type_camp <> 'uuid' OR v_type_kol <> 'uuid' THEN
    RAISE EXCEPTION 'COLUMN_VALIDATION_FAILED: Columns (campaign_id, kol_id) must be uuid, found (%, %).', v_type_camp, v_type_kol;
  END IF;

  IF v_notnull_camp IS NOT TRUE OR v_notnull_kol IS NOT TRUE THEN
    RAISE EXCEPTION 'COLUMN_VALIDATION_FAILED: Columns (campaign_id, kol_id) on %.bounty_claims must be NOT NULL.', v_target_schema;
  END IF;

  SELECT attnum, format_type(atttypid, atttypmod), attnotnull
  INTO v_attnum_tx, v_type_tx, v_notnull_tx
  FROM pg_attribute WHERE attrelid = v_rel_oid AND attname = 'tx_hash' AND NOT attisdropped;

  IF v_attnum_tx IS NOT NULL THEN
    IF v_type_tx <> 'character varying(66)' OR v_notnull_tx IS NOT FALSE THEN
      RAISE EXCEPTION 'COLUMN_VALIDATION_FAILED: Column "tx_hash" on %.bounty_claims must be nullable character varying(66). Found type=%, not_null=%.',
        v_target_schema, v_type_tx, v_notnull_tx;
    END IF;
  ELSE
    EXECUTE format('ALTER TABLE %I.%I ADD COLUMN tx_hash VARCHAR(66)', v_target_schema, 'bounty_claims');

    SELECT attnum, format_type(atttypid, atttypmod), attnotnull
    INTO v_attnum_tx, v_type_tx, v_notnull_tx
    FROM pg_attribute WHERE attrelid = v_rel_oid AND attname = 'tx_hash' AND NOT attisdropped;

    IF v_attnum_tx IS NULL OR v_type_tx <> 'character varying(66)' OR v_notnull_tx IS NOT FALSE THEN
      RAISE EXCEPTION 'COLUMN_VALIDATION_FAILED: Newly added column "tx_hash" on %.bounty_claims failed validation. attnum=%, type=%, not_null=%.',
        v_target_schema, v_attnum_tx, v_type_tx, v_notnull_tx;
    END IF;
  END IF;

  -- --------------------------------------------------------------------------
  -- 4. Duplicate Historical Data Scan Under Exclusive Lock
  -- --------------------------------------------------------------------------
  EXECUTE format('
    SELECT COUNT(*) FROM (
      SELECT campaign_id, kol_id FROM %I.%I GROUP BY campaign_id, kol_id HAVING COUNT(*) > 1
    ) sub', v_target_schema, 'bounty_claims') INTO v_dup_count;

  IF v_dup_count > 0 THEN
    RAISE EXCEPTION 'PRE_MIGRATION_VALIDATION_FAILED: Found % duplicate (campaign_id, kol_id) records in %.bounty_claims.', v_dup_count, v_target_schema;
  END IF;

  EXECUTE format('
    SELECT COUNT(*) FROM (
      SELECT tx_hash FROM %I.%I WHERE tx_hash IS NOT NULL GROUP BY tx_hash HAVING COUNT(*) > 1
    ) sub', v_target_schema, 'bounty_claims') INTO v_dup_count;

  IF v_dup_count > 0 THEN
    RAISE EXCEPTION 'PRE_MIGRATION_VALIDATION_FAILED: Found % duplicate tx_hash records in %.bounty_claims.', v_dup_count, v_target_schema;
  END IF;

  -- --------------------------------------------------------------------------
  -- 5. L-02: Constraint & Unique-Index Evaluation (campaign_id, kol_id)
  -- --------------------------------------------------------------------------
  -- 5.1 Unhealthy relevant index check (detects both key permutations)
  SELECT i.relname INTO v_con1_unhealthy_idx
  FROM pg_index ix
  JOIN pg_class i ON i.oid = ix.indexrelid
  WHERE ix.indrelid = v_rel_oid
    AND ix.indisunique = true
    AND (ix.indisvalid IS NOT TRUE OR ix.indisready IS NOT TRUE OR ix.indislive IS NOT TRUE)
    AND (
      (string_to_array(ix.indkey::text, ' '))[1 : ix.indnkeyatts]::smallint[] = ARRAY[v_attnum_camp, v_attnum_kol]
      OR (string_to_array(ix.indkey::text, ' '))[1 : ix.indnkeyatts]::smallint[] = ARRAY[v_attnum_kol, v_attnum_camp]
    )
  LIMIT 1;

  IF v_con1_unhealthy_idx IS NOT NULL THEN
    RAISE EXCEPTION 'MIGRATION_BLOCKED: Unhealthy unique index "%" detected on (campaign_id, kol_id). Cleanup required.', v_con1_unhealthy_idx;
  END IF;

  -- 5.2 Inspect same-name constraint (LEFT JOIN prevents missing non-index constraints)
  SELECT
    c.oid, c.contype, c.conkey, c.condeferrable, c.condeferred, c.convalidated,
    ix.indisvalid, ix.indisready, ix.indislive,
    (ix.indpred IS NOT NULL), (ix.indexprs IS NULL),
    (ix.indnkeyatts = ix.indnatts)
  INTO
    v_con1_oid, v_con1_type, v_con1_key, v_con1_deferrable, v_con1_deferred, v_con1_validated,
    v_con1_idx_valid, v_con1_idx_ready, v_con1_idx_live,
    v_con1_is_partial, v_con1_is_pure_keys, v_con1_no_include
  FROM pg_constraint c
  LEFT JOIN pg_index ix ON ix.indexrelid = c.conindid
  WHERE c.conrelid = v_rel_oid AND c.conname = 'uq_bounty_claims_campaign_kol';

  IF v_con1_oid IS NOT NULL THEN
    -- Strict three-valued logic assertions
    IF v_con1_type <> 'u'
       OR v_con1_key <> ARRAY[v_attnum_camp, v_attnum_kol]
       OR v_con1_deferrable IS NOT FALSE
       OR v_con1_deferred IS NOT FALSE
       OR v_con1_validated IS NOT TRUE
       OR v_con1_idx_valid IS NOT TRUE
       OR v_con1_idx_ready IS NOT TRUE
       OR v_con1_idx_live IS NOT TRUE
       OR v_con1_is_partial IS NOT FALSE
       OR v_con1_is_pure_keys IS NOT TRUE
       OR v_con1_no_include IS NOT TRUE THEN
      RAISE EXCEPTION 'MIGRATION_CONFLICT: Constraint "uq_bounty_claims_campaign_kol" fails semantic validation. Fail-closed.';
    END IF;
  ELSE
    -- 5.3 Detect equivalent unique constraint under different name (detects both key permutations)
    SELECT conname INTO v_con1_other_name
    FROM pg_constraint
    WHERE conrelid = v_rel_oid AND contype = 'u'
      AND (conkey = ARRAY[v_attnum_camp, v_attnum_kol] OR conkey = ARRAY[v_attnum_kol, v_attnum_camp])
    LIMIT 1;

    IF v_con1_other_name IS NOT NULL THEN
      RAISE EXCEPTION 'MIGRATION_BLOCKED: Equivalent unique constraint "%" already exists on (campaign_id, kol_id).', v_con1_other_name;
    END IF;

    -- 5.4 Detect standalone unique index covering target keys (detects both key permutations)
    SELECT i.relname INTO v_con1_stand_idx
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    WHERE ix.indrelid = v_rel_oid
      AND ix.indisunique = true
      AND ix.indisvalid = true AND ix.indisready = true AND ix.indislive = true
      AND ix.indpred IS NULL AND ix.indexprs IS NULL
      AND (
        (string_to_array(ix.indkey::text, ' '))[1 : ix.indnkeyatts]::smallint[] = ARRAY[v_attnum_camp, v_attnum_kol]
        OR (string_to_array(ix.indkey::text, ' '))[1 : ix.indnkeyatts]::smallint[] = ARRAY[v_attnum_kol, v_attnum_camp]
      )
      AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = ix.indexrelid)
    LIMIT 1;

    IF v_con1_stand_idx IS NOT NULL THEN
      RAISE EXCEPTION 'MIGRATION_BLOCKED: Standalone unique index "%" already covers (campaign_id, kol_id). Operator review required.', v_con1_stand_idx;
    END IF;

    EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT uq_bounty_claims_campaign_kol UNIQUE (campaign_id, kol_id)', v_target_schema, 'bounty_claims');
  END IF;

  -- --------------------------------------------------------------------------
  -- 6. H-06: Constraint & Unique Index Validation (tx_hash) (Version-Aware)
  -- --------------------------------------------------------------------------
  -- 6.1 Unhealthy relevant index check
  SELECT i.relname INTO v_con2_unhealthy_idx
  FROM pg_index ix
  JOIN pg_class i ON i.oid = ix.indexrelid
  WHERE ix.indrelid = v_rel_oid
    AND ix.indisunique = true
    AND (ix.indisvalid IS NOT TRUE OR ix.indisready IS NOT TRUE OR ix.indislive IS NOT TRUE)
    AND (string_to_array(ix.indkey::text, ' '))[1 : ix.indnkeyatts]::smallint[] = ARRAY[v_attnum_tx]
  LIMIT 1;

  IF v_con2_unhealthy_idx IS NOT NULL THEN
    RAISE EXCEPTION 'MIGRATION_BLOCKED: Unhealthy unique index "%" detected on (tx_hash). Cleanup required.', v_con2_unhealthy_idx;
  END IF;

  -- 6.2 Inspect same-name constraint (LEFT JOIN prevents missing non-index constraints)
  IF v_pg_version >= 150000 THEN
    v_query_con2 := '
      SELECT
        c.oid, c.contype, c.conkey, c.condeferrable, c.condeferred, c.convalidated,
        ix.indisvalid, ix.indisready, ix.indislive,
        (ix.indpred IS NOT NULL), (ix.indexprs IS NULL),
        (ix.indnkeyatts = ix.indnatts),
        ix.indnullsnotdistinct
      FROM pg_constraint c
      LEFT JOIN pg_index ix ON ix.indexrelid = c.conindid
      WHERE c.conrelid = $1 AND c.conname = $2';
  ELSE
    v_query_con2 := '
      SELECT
        c.oid, c.contype, c.conkey, c.condeferrable, c.condeferred, c.convalidated,
        ix.indisvalid, ix.indisready, ix.indislive,
        (ix.indpred IS NOT NULL), (ix.indexprs IS NULL),
        (ix.indnkeyatts = ix.indnatts),
        false AS indnullsnotdistinct
      FROM pg_constraint c
      LEFT JOIN pg_index ix ON ix.indexrelid = c.conindid
      WHERE c.conrelid = $1 AND c.conname = $2';
  END IF;

  EXECUTE v_query_con2
  INTO v_con2_oid, v_con2_type, v_con2_key, v_con2_deferrable, v_con2_deferred, v_con2_validated,
       v_con2_idx_valid, v_con2_idx_ready, v_con2_idx_live,
       v_con2_is_partial, v_con2_is_pure_keys, v_con2_no_include, v_con2_nulls_not_dist
  USING v_rel_oid, 'uq_bounty_claims_tx_hash';

  IF v_con2_oid IS NOT NULL THEN
    -- Strict three-valued logic assertions
    IF v_con2_type <> 'u'
       OR v_con2_key <> ARRAY[v_attnum_tx]
       OR v_con2_deferrable IS NOT FALSE
       OR v_con2_deferred IS NOT FALSE
       OR v_con2_validated IS NOT TRUE
       OR v_con2_idx_valid IS NOT TRUE
       OR v_con2_idx_ready IS NOT TRUE
       OR v_con2_idx_live IS NOT TRUE
       OR v_con2_is_partial IS NOT FALSE
       OR v_con2_is_pure_keys IS NOT TRUE
       OR v_con2_no_include IS NOT TRUE
       OR v_con2_nulls_not_dist IS NOT FALSE THEN
      RAISE EXCEPTION 'MIGRATION_CONFLICT: Constraint "uq_bounty_claims_tx_hash" fails semantic validation. Fail-closed.';
    END IF;
  ELSE
    -- 6.3 Detect equivalent unique constraint under different name
    SELECT conname INTO v_con2_other_name
    FROM pg_constraint
    WHERE conrelid = v_rel_oid AND contype = 'u' AND conkey = ARRAY[v_attnum_tx]
    LIMIT 1;

    IF v_con2_other_name IS NOT NULL THEN
      RAISE EXCEPTION 'MIGRATION_BLOCKED: Equivalent unique constraint "%" already exists on (tx_hash).', v_con2_other_name;
    END IF;

    -- 6.4 Detect standalone unique index covering target keys
    IF v_pg_version >= 150000 THEN
      v_query_idx2 := '
        SELECT i.relname, ix.indnullsnotdistinct
        FROM pg_index ix
        JOIN pg_class i ON i.oid = ix.indexrelid
        WHERE ix.indrelid = $1
          AND ix.indisunique = true
          AND ix.indisvalid = true AND ix.indisready = true AND ix.indislive = true
          AND ix.indpred IS NULL AND ix.indexprs IS NULL
          AND (string_to_array(ix.indkey::text, '' ''))[1 : ix.indnkeyatts]::smallint[] = ARRAY[$2::smallint]
          AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = ix.indexrelid)
        LIMIT 1';
    ELSE
      v_query_idx2 := '
        SELECT i.relname, false AS indnullsnotdistinct
        FROM pg_index ix
        JOIN pg_class i ON i.oid = ix.indexrelid
        WHERE ix.indrelid = $1
          AND ix.indisunique = true
          AND ix.indisvalid = true AND ix.indisready = true AND ix.indislive = true
          AND ix.indpred IS NULL AND ix.indexprs IS NULL
          AND (string_to_array(ix.indkey::text, '' ''))[1 : ix.indnkeyatts]::smallint[] = ARRAY[$2::smallint]
          AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = ix.indexrelid)
        LIMIT 1';
    END IF;

    EXECUTE v_query_idx2
    INTO v_con2_stand_idx, v_con2_nulls_not_dist
    USING v_rel_oid, v_attnum_tx;

    IF v_con2_stand_idx IS NOT NULL THEN
      IF v_con2_nulls_not_dist IS TRUE THEN
        RAISE EXCEPTION 'MIGRATION_CONFLICT: Standalone unique index "%" on (tx_hash) enforces NULLS NOT DISTINCT.', v_con2_stand_idx;
      ELSE
        RAISE EXCEPTION 'MIGRATION_BLOCKED: Standalone unique index "%" already covers (tx_hash). Operator review required.', v_con2_stand_idx;
      END IF;
    END IF;

    EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT uq_bounty_claims_tx_hash UNIQUE (tx_hash)', v_target_schema, 'bounty_claims');
  END IF;
END $$;

COMMIT;
