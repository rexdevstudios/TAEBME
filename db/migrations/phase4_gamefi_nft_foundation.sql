-- ============================================================================
-- PHASE 4: GAMEFI & NFT FOUNDATION MIGRATION
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS nft_collections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    symbol VARCHAR(64) NOT NULL,
    contract_address VARCHAR(128),
    chain VARCHAR(64) NOT NULL DEFAULT 'base-mainnet',
    max_supply BIGINT NOT NULL DEFAULT 10000,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nft_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    collection_id UUID REFERENCES nft_collections(id) ON DELETE CASCADE,
    token_id BIGINT NOT NULL,
    owner_wallet VARCHAR(128) NOT NULL,
    tier VARCHAR(32) NOT NULL DEFAULT 'BRONZE',
    metadata_uri TEXT NOT NULL,
    mint_tx_hash VARCHAR(128),
    minted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_collection_token UNIQUE(collection_id, token_id)
);

CREATE TABLE IF NOT EXISTS user_gamefi_profiles (
    user_id UUID PRIMARY KEY,
    xp BIGINT NOT NULL DEFAULT 0,
    level INTEGER NOT NULL DEFAULT 1,
    quests_completed INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS quest_definitions (
    id VARCHAR(128) PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    xp_reward INTEGER NOT NULL DEFAULT 100,
    badge_tier VARCHAR(32) DEFAULT 'BRONZE',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS quest_completions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    quest_id VARCHAR(128) REFERENCES quest_definitions(id) ON DELETE CASCADE,
    status VARCHAR(32) NOT NULL DEFAULT 'COMPLETED',
    xp_granted INTEGER NOT NULL DEFAULT 0,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_user_quest UNIQUE(user_id, quest_id)
);

-- Seed Initial GameFi Quests
INSERT INTO quest_definitions (id, title, description, xp_reward, badge_tier, is_active) VALUES
('connect_siwe', 'Connect SIWE Wallet', 'Cryptographically authenticate your wallet address via SIWE', 100, 'BRONZE', TRUE),
('verify_sybil', 'Verify Anti-Sybil Identity', 'Verify your humanity via World ID ZK-proof or Gitcoin Passport', 250, 'SILVER', TRUE),
('first_trade_or_launch', 'Execute Trade or Token Launch', 'Complete your first token launch or swap on RTrader launchpad', 500, 'GOLD', TRUE)
ON CONFLICT (id) DO NOTHING;

-- Indexes for high-performance lookup
CREATE INDEX IF NOT EXISTS idx_nft_items_owner ON nft_items(LOWER(owner_wallet));
CREATE INDEX IF NOT EXISTS idx_quest_completions_user ON quest_completions(user_id);
