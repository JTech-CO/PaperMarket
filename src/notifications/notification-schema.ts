/** Included once in the next immutable application migration. No user-supplied SQL. */
export const notificationSchemaSql = `
  CREATE TABLE notification_preferences (
    market_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    dm_enabled INTEGER NOT NULL DEFAULT 0 CHECK(dm_enabled IN (0,1)),
    consented_at TEXT,
    consent_version TEXT NOT NULL CHECK(length(consent_version) BETWEEN 1 AND 64),
    updated_at TEXT NOT NULL,
    PRIMARY KEY(market_id,account_id),
    FOREIGN KEY(market_id,account_id) REFERENCES accounts(market_id,account_id),
    CHECK(dm_enabled = 0 OR consented_at IS NOT NULL)
  ) STRICT;
  CREATE TABLE watched_listings (
    market_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    listing_id TEXT NOT NULL,
    symbol TEXT NOT NULL CHECK(length(symbol) BETWEEN 1 AND 12),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    created_at TEXT NOT NULL,
    PRIMARY KEY(market_id,account_id,listing_id),
    FOREIGN KEY(market_id,account_id) REFERENCES accounts(market_id,account_id),
    FOREIGN KEY(market_id,listing_id) REFERENCES listings(market_id,listing_id)
  ) STRICT;
  CREATE TABLE notification_seen (
    market_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    event_key TEXT NOT NULL CHECK(length(event_key) = 64 AND event_key NOT GLOB '*[^0-9a-f]*'),
    PRIMARY KEY(market_id,account_id,event_key),
    FOREIGN KEY(market_id,account_id) REFERENCES accounts(market_id,account_id)
  ) STRICT;
  CREATE TABLE price_alerts (
    alert_id TEXT PRIMARY KEY CHECK(length(alert_id) = 36),
    market_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    listing_id TEXT NOT NULL,
    symbol TEXT NOT NULL CHECK(length(symbol) BETWEEN 1 AND 12),
    direction TEXT NOT NULL CHECK(direction IN ('ABOVE','BELOW')),
    threshold TEXT NOT NULL CHECK(length(threshold) BETWEEN 1 AND 96),
    enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
    armed INTEGER NOT NULL CHECK(armed IN (0,1)),
    last_price TEXT NOT NULL CHECK(length(last_price) BETWEEN 1 AND 96),
    last_tick INTEGER NOT NULL CHECK(last_tick BETWEEN 0 AND 9007199254740991),
    disabled_reason TEXT CHECK(disabled_reason IS NULL OR disabled_reason = 'LISTING_RETIRED'),
    created_at TEXT NOT NULL,
    FOREIGN KEY(market_id,account_id) REFERENCES accounts(market_id,account_id),
    FOREIGN KEY(market_id,listing_id) REFERENCES listings(market_id,listing_id),
    UNIQUE(market_id,account_id,listing_id,direction,threshold),
    CHECK((enabled = 1 AND disabled_reason IS NULL) OR (enabled = 0 AND disabled_reason = 'LISTING_RETIRED'))
  ) STRICT;
  CREATE INDEX price_alerts_market_active ON price_alerts(market_id,enabled,account_id);
  CREATE TABLE notification_inbox (
    inbox_no INTEGER PRIMARY KEY AUTOINCREMENT,
    notification_id TEXT NOT NULL UNIQUE CHECK(length(notification_id) = 36),
    event_key TEXT NOT NULL CHECK(length(event_key) = 64 AND event_key NOT GLOB '*[^0-9a-f]*'),
    market_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('IMPORTANT_DISCLOSURE','DIVIDEND_RIGHT','DIVIDEND_PAID','SCHEDULED_FILLED','ORDER_CANCELLED','PRICE_THRESHOLD')),
    symbol TEXT CHECK(symbol IS NULL OR length(symbol) BETWEEN 1 AND 12),
    title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 100),
    summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 1200),
    tick_no INTEGER NOT NULL CHECK(tick_no BETWEEN 0 AND 9007199254740991),
    market_version INTEGER NOT NULL CHECK(market_version BETWEEN 0 AND 9007199254740991),
    created_at TEXT NOT NULL,
    read_at TEXT,
    FOREIGN KEY(market_id,account_id) REFERENCES accounts(market_id,account_id),
    UNIQUE(market_id,account_id,event_key)
  ) STRICT;
  CREATE INDEX notification_inbox_owner ON notification_inbox(market_id,account_id,inbox_no DESC);
  CREATE TABLE notification_outbox (
    job_id TEXT PRIMARY KEY CHECK(length(job_id) = 36),
    notification_id TEXT NOT NULL UNIQUE REFERENCES notification_inbox(notification_id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(status IN ('PENDING','LEASED','DELIVERED','FAILED','CANCELLED')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 8),
    next_attempt_at TEXT NOT NULL,
    lease_token TEXT CHECK(lease_token IS NULL OR length(lease_token) = 36),
    lease_expires_at TEXT,
    delivered_at TEXT,
    CHECK((status = 'LEASED' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR
      (status <> 'LEASED' AND lease_token IS NULL AND lease_expires_at IS NULL))
  ) STRICT;
  CREATE INDEX notification_outbox_due ON notification_outbox(status,next_attempt_at,lease_expires_at);
`;
