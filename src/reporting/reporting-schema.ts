export const reportingSchemaSql = `
  CREATE TABLE export_access (
    access_id TEXT PRIMARY KEY CHECK(length(access_id)=36),
    market_id TEXT NOT NULL,account_id TEXT NOT NULL,
    format TEXT NOT NULL CHECK(format IN ('CSV','JSON')),
    market_version INTEGER NOT NULL CHECK(market_version>=0),
    record_count INTEGER NOT NULL CHECK(record_count BETWEEN 0 AND 1000),
    accessed_at TEXT NOT NULL,
    FOREIGN KEY(market_id,account_id) REFERENCES accounts(market_id,account_id)
  ) STRICT;
  CREATE INDEX export_access_owner ON export_access(market_id,account_id);
  CREATE TABLE performance_samples (
    market_id TEXT NOT NULL, account_id TEXT NOT NULL,
    tick_no INTEGER NOT NULL CHECK(tick_no BETWEEN 0 AND 9007199254740991),
    market_version INTEGER NOT NULL CHECK(market_version BETWEEN 0 AND 9007199254740991),
    equity_atoms TEXT NOT NULL CHECK(length(equity_atoms) BETWEEN 1 AND 51),
    sampled_at TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('LIVE_TICK_END','HISTORICAL_TICK_END')),
    previous_hash TEXT NOT NULL CHECK(length(previous_hash) IN (0,64)),
    sample_hash TEXT NOT NULL CHECK(length(sample_hash)=64),
    PRIMARY KEY(market_id,account_id,tick_no),
    FOREIGN KEY(market_id,account_id) REFERENCES accounts(market_id,account_id)
  ) STRICT;
  CREATE TRIGGER performance_samples_no_update BEFORE UPDATE ON performance_samples BEGIN SELECT RAISE(ABORT,'append-only performance'); END;
  CREATE TRIGGER performance_samples_no_delete BEFORE DELETE ON performance_samples BEGIN SELECT RAISE(ABORT,'append-only performance'); END;
`;
