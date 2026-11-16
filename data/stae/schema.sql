-- ============================================================================
-- SIDRA TEMPEST ARBITRAGE ENGINE (STAE) — AUDITABLE LEDGER SCHEMA
-- Chain ID: 97453 (Sidra Chain) | Currency: SDA / WSDA / GMAI
-- NOTE: Private keys are NEVER stored in any table or file.
-- ============================================================================

CREATE TABLE IF NOT EXISTS wallets (
    wallet_id TEXT PRIMARY KEY,
    address TEXT NOT NULL UNIQUE,
    native_sda_wei TEXT NOT NULL DEFAULT '0',
    wsda_wei TEXT NOT NULL DEFAULT '0',
    gmai_wei TEXT NOT NULL DEFAULT '0',
    last_nonce INTEGER NOT NULL DEFAULT 0,
    max_trade_sda_wei TEXT NOT NULL,
    min_gas_reserve_wei TEXT NOT NULL,
    realized_net_profit_wei TEXT NOT NULL DEFAULT '0',
    total_trades INTEGER NOT NULL DEFAULT 0,
    failed_trades INTEGER NOT NULL DEFAULT 0,
    health_status TEXT NOT NULL DEFAULT 'HEALTHY',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pool_registry (
    pool_address TEXT PRIMARY KEY,
    token_symbol TEXT NOT NULL,
    token_address TEXT NOT NULL,
    token_decimals INTEGER NOT NULL DEFAULT 18,
    fee_tier INTEGER NOT NULL,
    is_token0_wsda INTEGER NOT NULL,
    sqrt_price_x96 TEXT NOT NULL,
    liquidity_wei TEXT NOT NULL,
    virtual_wsda_depth_sda REAL NOT NULL,
    spot_price_sda REAL NOT NULL,
    tax_bps INTEGER NOT NULL DEFAULT 0,
    is_healthy INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS opportunities (
    opportunity_id TEXT PRIMARY KEY,
    round_number INTEGER NOT NULL,
    strategy_type TEXT NOT NULL, -- CROSS_POOL_ATOMIC, MULTI_HOP_ATOMIC, TRIANGULAR_ATOMIC, NON_ATOMIC_DUAL_LEG
    is_atomic INTEGER NOT NULL,
    token_symbol TEXT NOT NULL,
    token_address TEXT NOT NULL,
    pool_buy_address TEXT NOT NULL,
    pool_sell_address TEXT NOT NULL,
    fee_buy INTEGER NOT NULL,
    fee_sell INTEGER NOT NULL,
    input_sda_wei TEXT NOT NULL,
    expected_out_sda_wei TEXT NOT NULL,
    expected_gas_wei TEXT NOT NULL,
    expected_net_profit_wei TEXT NOT NULL,
    price_impact_pct REAL NOT NULL,
    risk_score REAL NOT NULL,
    risk_decision TEXT NOT NULL, -- APPROVED, REJECTED
    rejection_reason TEXT,
    discovered_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
    tx_hash TEXT PRIMARY KEY,
    opportunity_id TEXT,
    wallet_id TEXT NOT NULL,
    wallet_address TEXT NOT NULL,
    execution_mode TEXT NOT NULL, -- DRY_RUN, LIVE_ATOMIC_EXACT_INPUT, LIVE_DUAL_LEG
    token_symbol TEXT NOT NULL,
    block_number INTEGER,
    nonce INTEGER NOT NULL,
    amount_in_wei TEXT NOT NULL,
    amount_out_min_wei TEXT NOT NULL,
    realized_out_wei TEXT NOT NULL,
    gas_used TEXT NOT NULL,
    effective_gas_price_wei TEXT NOT NULL,
    total_gas_cost_wei TEXT NOT NULL,
    gross_profit_wei TEXT NOT NULL,
    realized_net_profit_wei TEXT NOT NULL,
    wsda_before_wei TEXT NOT NULL,
    wsda_after_wei TEXT NOT NULL,
    native_before_wei TEXT NOT NULL,
    native_after_wei TEXT NOT NULL,
    status TEXT NOT NULL, -- CONFIRMED, REVERTED, SIMULATED
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gmai_allocations (
    allocation_id TEXT PRIMARY KEY,
    source_tx_hash TEXT NOT NULL,
    wallet_id TEXT NOT NULL,
    allocation_mode TEXT NOT NULL, -- MODE_A_GMAI_ACCUMULATION, MODE_B_GMAI_LP_PROVISION
    realized_profit_wei TEXT NOT NULL,
    wallet_retained_wei TEXT NOT NULL,
    gmai_allocated_sda_wei TEXT NOT NULL,
    gmai_tokens_received_wei TEXT NOT NULL,
    allocation_tx_hash TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS risk_events (
    event_id TEXT PRIMARY KEY,
    severity TEXT NOT NULL, -- INFO, WARNING, CRITICAL, EMERGENCY_STOP
    category TEXT NOT NULL,
    message TEXT NOT NULL,
    metadata_json TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS security_findings (
    finding_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    severity TEXT NOT NULL, -- CRITICAL, HIGH, MEDIUM, LOW, INFORMATIONAL
    status TEXT NOT NULL, -- CONFIRMED, REMEDIATED, INFORMATIONAL
    affected_asset TEXT NOT NULL,
    evidence TEXT NOT NULL,
    remediation TEXT NOT NULL,
    cvss_score REAL,
    created_at TEXT NOT NULL
);

