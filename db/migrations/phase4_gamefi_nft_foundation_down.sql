-- ============================================================================
-- PHASE 4: GAMEFI & NFT FOUNDATION ROLLBACK MIGRATION
-- ============================================================================

DROP INDEX IF EXISTS idx_quest_completions_user;
DROP INDEX IF EXISTS idx_nft_items_owner;
DROP TABLE IF EXISTS quest_completions CASCADE;
DROP TABLE IF EXISTS quest_definitions CASCADE;
DROP TABLE IF EXISTS user_gamefi_profiles CASCADE;
DROP TABLE IF EXISTS nft_items CASCADE;
DROP TABLE IF EXISTS nft_collections CASCADE;
