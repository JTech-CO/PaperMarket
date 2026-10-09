/** Appended to migration 6; earlier migration checksums remain unchanged. */
export const benchmarkSchemaSql = `
  CREATE TABLE benchmark_series (
    market_id TEXT NOT NULL REFERENCES markets(market_id),
    series_id TEXT NOT NULL CHECK(length(series_id) BETWEEN 1 AND 256),
    account_id TEXT,
    kind TEXT NOT NULL CHECK(kind IN ('CASH','HOLD8','PM8')),
    start_tick INTEGER NOT NULL CHECK(start_tick BETWEEN 0 AND 9007199254740991),
    opening_elapsed_ms INTEGER NOT NULL CHECK(opening_elapsed_ms BETWEEN 0 AND 300000),
    opening_policy TEXT NOT NULL CHECK(opening_policy IN ('EXACT_ACTIVE_OFFSET','LEGACY_BOUNDARY_ONLY','MARKET_ADOPTION')),
    PRIMARY KEY(market_id,series_id),
    UNIQUE(market_id,account_id,kind),
    FOREIGN KEY(market_id,account_id) REFERENCES accounts(market_id,account_id),
    CHECK((kind='PM8' AND account_id IS NULL AND opening_policy='MARKET_ADOPTION') OR
      (kind IN ('CASH','HOLD8') AND account_id IS NOT NULL AND opening_policy<>'MARKET_ADOPTION'))
  ) STRICT;
  CREATE UNIQUE INDEX benchmark_one_pm8 ON benchmark_series(market_id) WHERE kind='PM8';
  CREATE TRIGGER benchmark_series_no_update BEFORE UPDATE ON benchmark_series BEGIN SELECT RAISE(ABORT,'immutable benchmark identity'); END;
  CREATE TRIGGER benchmark_series_no_delete BEFORE DELETE ON benchmark_series BEGIN SELECT RAISE(ABORT,'persistent benchmark identity'); END;
  CREATE TABLE benchmark_snapshots (
    market_id TEXT NOT NULL,
    series_id TEXT NOT NULL,
    tick_no INTEGER NOT NULL CHECK(tick_no BETWEEN 0 AND 9007199254740991),
    market_version INTEGER NOT NULL CHECK(market_version BETWEEN 0 AND 9007199254740991),
    source_hash TEXT NOT NULL CHECK(length(source_hash)=64),
    previous_hash TEXT NOT NULL CHECK(length(previous_hash) IN (0,64)),
    state_json TEXT NOT NULL CHECK(length(state_json) BETWEEN 1 AND 1048576 AND json_valid(state_json)),
    equity_json TEXT NOT NULL CHECK(length(equity_json) BETWEEN 1 AND 16384 AND json_valid(equity_json)),
    state_hash TEXT NOT NULL CHECK(length(state_hash)=64),
    PRIMARY KEY(market_id,series_id,tick_no),
    FOREIGN KEY(market_id,series_id) REFERENCES benchmark_series(market_id,series_id)
  ) STRICT;
  CREATE TRIGGER benchmark_snapshots_no_update BEFORE UPDATE ON benchmark_snapshots BEGIN SELECT RAISE(ABORT,'append-only benchmark'); END;
  CREATE TRIGGER benchmark_snapshots_no_delete BEFORE DELETE ON benchmark_snapshots BEGIN SELECT RAISE(ABORT,'append-only benchmark'); END;
`;
