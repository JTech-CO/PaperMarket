import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { benchmarkSchemaSql } from '../reporting/benchmark-schema.js';
import { reportingSchemaSql } from '../reporting/reporting-schema.js';
import { notificationSchemaSql } from '../notifications/notification-schema.js';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const foundationSql = `
  CREATE TABLE markets (
    market_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL CHECK(length(guild_id) BETWEEN 17 AND 20 AND guild_id NOT GLOB '*[^0-9]*'),
    state TEXT NOT NULL CHECK(state IN ('INITIALIZING','OPEN','UPDATING','PAUSED','RECOVERING','ARCHIVED')),
    tick_no INTEGER NOT NULL DEFAULT 0 CHECK(tick_no BETWEEN 0 AND 9007199254740991),
    market_version INTEGER NOT NULL DEFAULT 0 CHECK(market_version BETWEEN 0 AND 9007199254740991),
    sequence_no INTEGER NOT NULL DEFAULT 0 CHECK(sequence_no BETWEEN 0 AND 9007199254740991),
    engine_version TEXT NOT NULL,
    ruleset_version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    next_boundary_at TEXT NOT NULL
  ) STRICT;
  CREATE UNIQUE INDEX markets_one_active_per_guild ON markets(guild_id) WHERE state <> 'ARCHIVED';

  CREATE TABLE issuers (
    market_id TEXT NOT NULL REFERENCES markets(market_id),
    issuer_id TEXT NOT NULL,
    category TEXT NOT NULL CHECK(category IN ('ORDINARY','GROWTH','THEMATIC','DIVIDEND')),
    PRIMARY KEY(market_id, issuer_id),
    UNIQUE(market_id, issuer_id, category)
  ) STRICT;

  CREATE TABLE listings (
    market_id TEXT NOT NULL REFERENCES markets(market_id),
    listing_id TEXT NOT NULL,
    issuer_id TEXT NOT NULL,
    slot_id TEXT NOT NULL CHECK(slot_id IN ('O1','O2','O3','G1','G2','T1','T2','D1')),
    category TEXT NOT NULL,
    symbol TEXT NOT NULL CHECK(length(symbol) BETWEEN 1 AND 12),
    price TEXT NOT NULL CHECK(length(price) BETWEEN 1 AND 128),
    status TEXT NOT NULL CHECK(status IN ('ACTIVE','LIQUIDATING','EXTINGUISHED')),
    created_at TEXT NOT NULL,
    PRIMARY KEY(market_id, listing_id),
    FOREIGN KEY(market_id, issuer_id, category) REFERENCES issuers(market_id, issuer_id, category),
    CHECK((slot_id IN ('O1','O2','O3') AND category = 'ORDINARY') OR
      (slot_id IN ('G1','G2') AND category = 'GROWTH') OR
      (slot_id IN ('T1','T2') AND category = 'THEMATIC') OR
      (slot_id = 'D1' AND category = 'DIVIDEND'))
  ) STRICT;
  CREATE UNIQUE INDEX listings_one_active_per_slot ON listings(market_id,slot_id) WHERE status = 'ACTIVE';
  CREATE UNIQUE INDEX listings_active_symbol ON listings(market_id,symbol) WHERE status = 'ACTIVE';
  CREATE UNIQUE INDEX listings_active_issuer ON listings(market_id,issuer_id) WHERE status = 'ACTIVE';

  CREATE TABLE accounts (
    account_id TEXT PRIMARY KEY,
    market_id TEXT NOT NULL REFERENCES markets(market_id),
    discord_user_id TEXT NOT NULL CHECK(length(discord_user_id) BETWEEN 17 AND 20 AND discord_user_id NOT GLOB '*[^0-9]*'),
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','CLOSED')),
    account_version INTEGER NOT NULL DEFAULT 1 CHECK(account_version BETWEEN 1 AND 9007199254740991),
    created_at TEXT NOT NULL,
    UNIQUE(market_id,discord_user_id),
    UNIQUE(market_id,account_id),
    UNIQUE(market_id,account_id,discord_user_id)
  ) STRICT;
  CREATE TRIGGER accounts_no_delete BEFORE DELETE ON accounts
    BEGIN SELECT RAISE(ABORT, 'persistent account cannot be reset'); END;
  CREATE TRIGGER accounts_owner_immutable BEFORE UPDATE OF account_id,market_id,discord_user_id,created_at ON accounts
    BEGIN SELECT RAISE(ABORT, 'account identity is immutable'); END;

  CREATE TABLE cash_journal (
    journal_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    cause_id TEXT NOT NULL,
    market_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    entry_type TEXT NOT NULL CHECK(entry_type IN ('INITIAL_GRANT','TRADE','DIVIDEND','INTEREST','LIQUIDATION','REVERSAL','ROUNDING')),
    account_delta_atoms TEXT NOT NULL CHECK(length(account_delta_atoms) BETWEEN 1 AND 51 AND length(ltrim(account_delta_atoms,'-')) <= 50 AND (account_delta_atoms = '0' OR (account_delta_atoms GLOB '[1-9]*' AND account_delta_atoms NOT GLOB '*[^0-9]*') OR (account_delta_atoms GLOB '-[1-9]*' AND substr(account_delta_atoms, 2) NOT GLOB '*[^0-9]*'))),
    system_delta_atoms TEXT NOT NULL CHECK(length(system_delta_atoms) BETWEEN 1 AND 51 AND length(ltrim(system_delta_atoms,'-')) <= 50 AND (system_delta_atoms = '0' OR (system_delta_atoms GLOB '[1-9]*' AND system_delta_atoms NOT GLOB '*[^0-9]*') OR (system_delta_atoms GLOB '-[1-9]*' AND substr(system_delta_atoms, 2) NOT GLOB '*[^0-9]*'))),
    system_account TEXT NOT NULL CHECK(system_account IN ('INITIAL_CAPITAL','BROKER','DIVIDEND','INTEREST','LIQUIDATION','ROUNDING')),
    currency TEXT NOT NULL DEFAULT 'PAPERMARKET_POINT' CHECK(currency = 'PAPERMARKET_POINT'),
    tick_no INTEGER NOT NULL CHECK(tick_no BETWEEN 0 AND 9007199254740991),
    market_version INTEGER NOT NULL CHECK(market_version BETWEEN 0 AND 9007199254740991),
    sequence_no INTEGER NOT NULL CHECK(sequence_no BETWEEN 1 AND 9007199254740991),
    engine_version TEXT NOT NULL,
    ruleset_version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    related_order_id TEXT,
    FOREIGN KEY(market_id,account_id) REFERENCES accounts(market_id,account_id),
    UNIQUE(market_id,account_id,event_id),
    CHECK(system_delta_atoms = CASE WHEN account_delta_atoms = '0' THEN '0' WHEN substr(account_delta_atoms, 1, 1) = '-' THEN substr(account_delta_atoms, 2) ELSE '-' || account_delta_atoms END),
    CHECK(entry_type <> 'INITIAL_GRANT' OR (account_delta_atoms = '10000000000000000' AND system_account = 'INITIAL_CAPITAL'))
  ) STRICT;
  CREATE INDEX cash_journal_account_sequence ON cash_journal(market_id,account_id,sequence_no,journal_id);
  CREATE UNIQUE INDEX cash_journal_one_initial_grant ON cash_journal(market_id,account_id) WHERE entry_type = 'INITIAL_GRANT';
  CREATE TRIGGER cash_journal_no_update BEFORE UPDATE ON cash_journal BEGIN SELECT RAISE(ABORT, 'append-only record'); END;
  CREATE TRIGGER cash_journal_no_delete BEFORE DELETE ON cash_journal BEGIN SELECT RAISE(ABORT, 'append-only record'); END;

  CREATE TABLE position_journal (
    journal_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    cause_id TEXT NOT NULL,
    market_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    listing_id TEXT NOT NULL,
    quantity_delta TEXT NOT NULL CHECK(length(quantity_delta) BETWEEN 1 AND 128 AND quantity_delta NOT GLOB '*[^0-9.e+-]*'),
    system_quantity_delta TEXT NOT NULL CHECK(length(system_quantity_delta) BETWEEN 1 AND 128 AND system_quantity_delta NOT GLOB '*[^0-9.e+-]*'),
    cost_delta_atoms TEXT NOT NULL CHECK(length(cost_delta_atoms) BETWEEN 1 AND 51 AND length(ltrim(cost_delta_atoms,'-')) <= 50 AND (cost_delta_atoms = '0' OR (cost_delta_atoms GLOB '[1-9]*' AND cost_delta_atoms NOT GLOB '*[^0-9]*') OR (cost_delta_atoms GLOB '-[1-9]*' AND substr(cost_delta_atoms, 2) NOT GLOB '*[^0-9]*'))),
    tick_no INTEGER NOT NULL CHECK(tick_no BETWEEN 0 AND 9007199254740991),
    market_version INTEGER NOT NULL CHECK(market_version BETWEEN 0 AND 9007199254740991),
    sequence_no INTEGER NOT NULL CHECK(sequence_no BETWEEN 1 AND 9007199254740991),
    engine_version TEXT NOT NULL,
    ruleset_version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    related_order_id TEXT,
    FOREIGN KEY(market_id,account_id) REFERENCES accounts(market_id,account_id),
    FOREIGN KEY(market_id,listing_id) REFERENCES listings(market_id,listing_id),
    UNIQUE(market_id,account_id,event_id,listing_id),
    CHECK(system_quantity_delta = CASE WHEN quantity_delta = '0' THEN '0' WHEN substr(quantity_delta, 1, 1) = '-' THEN substr(quantity_delta, 2) ELSE '-' || quantity_delta END)
  ) STRICT;
  CREATE INDEX position_journal_account_sequence ON position_journal(market_id,account_id,sequence_no,journal_id);
  CREATE TRIGGER position_journal_no_update BEFORE UPDATE ON position_journal BEGIN SELECT RAISE(ABORT, 'append-only record'); END;
  CREATE TRIGGER position_journal_no_delete BEFORE DELETE ON position_journal BEGIN SELECT RAISE(ABORT, 'append-only record'); END;

  CREATE TABLE processed_commands (
    interaction_id TEXT PRIMARY KEY CHECK(length(interaction_id) BETWEEN 17 AND 20 AND interaction_id NOT GLOB '*[^0-9]*'),
    market_id TEXT NOT NULL,
    discord_user_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    command_type TEXT NOT NULL CHECK(command_type = 'OPEN_ACCOUNT'),
    payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
    result_json TEXT NOT NULL CHECK(length(result_json) BETWEEN 1 AND 4096 AND json_valid(result_json)),
    sequence_no INTEGER NOT NULL CHECK(sequence_no BETWEEN 1 AND 9007199254740991),
    created_at TEXT NOT NULL,
    FOREIGN KEY(market_id,account_id,discord_user_id) REFERENCES accounts(market_id,account_id,discord_user_id),
    UNIQUE(market_id,sequence_no)
  ) STRICT;
  CREATE TRIGGER processed_commands_no_update BEFORE UPDATE ON processed_commands BEGIN SELECT RAISE(ABORT, 'append-only record'); END;
  CREATE TRIGGER processed_commands_no_delete BEFORE DELETE ON processed_commands BEGIN SELECT RAISE(ABORT, 'append-only record'); END;
  PRAGMA user_version = 1;
`;

const brokerSql = `
  DROP TRIGGER accounts_owner_immutable;
  CREATE TRIGGER accounts_owner_immutable BEFORE UPDATE OF account_id,market_id,discord_user_id,created_at ON accounts
    WHEN NEW.account_id <> OLD.account_id OR NEW.market_id <> OLD.market_id OR NEW.created_at <> OLD.created_at OR
      (NEW.discord_user_id <> OLD.discord_user_id AND (OLD.status <> 'CLOSED' OR NEW.status <> 'CLOSED'))
    BEGIN SELECT RAISE(ABORT, 'account identity is immutable except closed pseudonymization'); END;
  CREATE TRIGGER accounts_closed_permanent BEFORE UPDATE OF status ON accounts
    WHEN OLD.status = 'CLOSED' AND NEW.status <> 'CLOSED'
    BEGIN SELECT RAISE(ABORT, 'closed account cannot reopen'); END;
  DROP TRIGGER processed_commands_no_delete;
  CREATE TRIGGER processed_commands_no_delete BEFORE DELETE ON processed_commands
    WHEN NOT EXISTS (SELECT 1 FROM accounts a WHERE a.market_id = OLD.market_id AND a.account_id = OLD.account_id AND a.status = 'CLOSED')
    BEGIN SELECT RAISE(ABORT, 'append-only record'); END;

  CREATE TABLE account_subjects (
    market_id TEXT NOT NULL,
    subject_hash TEXT NOT NULL CHECK(length(subject_hash) = 64 AND subject_hash NOT GLOB '*[^0-9a-f]*'),
    account_id TEXT NOT NULL,
    closed_at TEXT,
    PRIMARY KEY(market_id,subject_hash),
    FOREIGN KEY(market_id,account_id) REFERENCES accounts(market_id,account_id)
  ) STRICT;
  CREATE TRIGGER account_subjects_immutable BEFORE UPDATE ON account_subjects
    WHEN NEW.market_id <> OLD.market_id OR NEW.subject_hash <> OLD.subject_hash OR NEW.account_id <> OLD.account_id OR
      OLD.closed_at IS NOT NULL OR NEW.closed_at IS NULL OR
      NOT EXISTS (SELECT 1 FROM accounts a WHERE a.market_id = OLD.market_id AND a.account_id = OLD.account_id AND a.status = 'CLOSED')
    BEGIN SELECT RAISE(ABORT, 'subject binding and closure are permanent'); END;
  CREATE TRIGGER account_subjects_no_delete BEFORE DELETE ON account_subjects BEGIN SELECT RAISE(ABORT, 'subject binding is permanent'); END;
  CREATE TABLE broker_metadata (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    identity_key_check TEXT NOT NULL CHECK(length(identity_key_check) = 64)
  ) STRICT;
  CREATE TRIGGER broker_metadata_no_update BEFORE UPDATE ON broker_metadata BEGIN SELECT RAISE(ABORT, 'identity key cannot change'); END;
  CREATE TRIGGER broker_metadata_no_delete BEFORE DELETE ON broker_metadata BEGIN SELECT RAISE(ABORT, 'identity key cannot change'); END;
  CREATE TABLE market_settings (
    market_id TEXT PRIMARY KEY REFERENCES markets(market_id),
    market_channel_id TEXT NOT NULL CHECK(length(market_channel_id) BETWEEN 17 AND 20 AND market_channel_id NOT GLOB '*[^0-9]*'),
    board_message_id TEXT CHECK(board_message_id IS NULL OR (length(board_message_id) BETWEEN 17 AND 20 AND board_message_id NOT GLOB '*[^0-9]*')),
    quote_provider TEXT NOT NULL CHECK(quote_provider = 'STATIC_TRIAL'),
    configured_at TEXT NOT NULL,
    checkpoint_at TEXT NOT NULL,
    remaining_ms INTEGER NOT NULL CHECK(remaining_ms BETWEEN 0 AND 300000)
  ) STRICT;

  CREATE TABLE policy_acceptances (
    market_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    actor_hash TEXT NOT NULL CHECK(length(actor_hash) = 64 AND actor_hash NOT GLOB '*[^0-9a-f]*'),
    terms_version TEXT NOT NULL CHECK(length(terms_version) BETWEEN 1 AND 64),
    privacy_version TEXT NOT NULL CHECK(length(privacy_version) BETWEEN 1 AND 64),
    age14_plus INTEGER NOT NULL CHECK(age14_plus = 1),
    agree_terms INTEGER NOT NULL CHECK(agree_terms = 1),
    accepted_at TEXT NOT NULL,
    PRIMARY KEY(market_id,account_id,terms_version,privacy_version),
    FOREIGN KEY(market_id,account_id) REFERENCES accounts(market_id,account_id)
  ) STRICT;
  CREATE TRIGGER policy_acceptances_no_update BEFORE UPDATE ON policy_acceptances BEGIN SELECT RAISE(ABORT, 'append-only record'); END;
  CREATE TRIGGER policy_acceptances_no_delete BEFORE DELETE ON policy_acceptances
    WHEN NOT EXISTS (SELECT 1 FROM accounts a WHERE a.market_id = OLD.market_id AND a.account_id = OLD.account_id AND a.status = 'CLOSED')
    BEGIN SELECT RAISE(ABORT, 'append-only record'); END;

  CREATE TABLE order_intents (
    intent_id TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE CHECK(length(token) = 43 AND token NOT GLOB '*[^A-Za-z0-9_-]*'),
    market_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    actor_hash TEXT NOT NULL CHECK(length(actor_hash) = 64 AND actor_hash NOT GLOB '*[^0-9a-f]*'),
    listing_id TEXT NOT NULL,
    side TEXT NOT NULL CHECK(side IN ('BUY','SELL')),
    quantity TEXT NOT NULL CHECK(length(quantity) BETWEEN 1 AND 128),
    price TEXT NOT NULL CHECK(length(price) BETWEEN 1 AND 128),
    quoted_cash_after_atoms TEXT NOT NULL CHECK(length(quoted_cash_after_atoms) BETWEEN 1 AND 50 AND quoted_cash_after_atoms NOT GLOB '*[^0-9]*'),
    account_version INTEGER NOT NULL CHECK(account_version BETWEEN 1 AND 9007199254740991),
    market_version INTEGER NOT NULL CHECK(market_version BETWEEN 0 AND 9007199254740991),
    tick_no INTEGER NOT NULL CHECK(tick_no BETWEEN 0 AND 9007199254740991),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','FILLED','CANCELLED','EXPIRED','REJECTED')),
    FOREIGN KEY(market_id,account_id) REFERENCES accounts(market_id,account_id),
    FOREIGN KEY(market_id,listing_id) REFERENCES listings(market_id,listing_id),
    UNIQUE(market_id,account_id,intent_id)
  ) STRICT;
  CREATE INDEX order_intents_owner ON order_intents(market_id,actor_hash,status);
  CREATE TRIGGER order_intents_immutable BEFORE UPDATE ON order_intents
    WHEN NEW.intent_id <> OLD.intent_id OR NEW.market_id <> OLD.market_id OR NEW.account_id <> OLD.account_id OR
      NEW.actor_hash <> OLD.actor_hash OR NEW.listing_id <> OLD.listing_id OR NEW.side <> OLD.side OR
      NEW.quantity <> OLD.quantity OR NEW.price <> OLD.price OR NEW.quoted_cash_after_atoms <> OLD.quoted_cash_after_atoms OR
      NEW.account_version <> OLD.account_version OR NEW.market_version <> OLD.market_version OR NEW.tick_no <> OLD.tick_no OR
      NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at OR
      (OLD.status <> 'DRAFT' AND NEW.status <> OLD.status) OR
      (NEW.token <> OLD.token AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.market_id = OLD.market_id AND a.account_id = OLD.account_id AND a.status = 'CLOSED'))
    BEGIN SELECT RAISE(ABORT, 'intent terms and termination are immutable'); END;

  CREATE TABLE orders (
    order_id TEXT PRIMARY KEY,
    intent_id TEXT NOT NULL UNIQUE,
    market_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    actor_hash TEXT NOT NULL CHECK(length(actor_hash) = 64 AND actor_hash NOT GLOB '*[^0-9a-f]*'),
    listing_id TEXT NOT NULL,
    side TEXT NOT NULL CHECK(side IN ('BUY','SELL')),
    order_type TEXT NOT NULL CHECK(order_type = 'MARKET'),
    status TEXT NOT NULL CHECK(status = 'FILLED'),
    sequence_no INTEGER NOT NULL CHECK(sequence_no BETWEEN 1 AND 9007199254740991),
    created_at TEXT NOT NULL,
    FOREIGN KEY(market_id,account_id,intent_id) REFERENCES order_intents(market_id,account_id,intent_id),
    FOREIGN KEY(market_id,account_id) REFERENCES accounts(market_id,account_id),
    FOREIGN KEY(market_id,listing_id) REFERENCES listings(market_id,listing_id),
    UNIQUE(market_id,sequence_no),
    UNIQUE(market_id,account_id,order_id)
  ) STRICT;
  CREATE TRIGGER orders_no_update BEFORE UPDATE ON orders BEGIN SELECT RAISE(ABORT, 'append-only record'); END;
  CREATE TRIGGER orders_no_delete BEFORE DELETE ON orders BEGIN SELECT RAISE(ABORT, 'append-only record'); END;

  CREATE TABLE fills (
    fill_id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL UNIQUE,
    intent_id TEXT NOT NULL UNIQUE REFERENCES order_intents(intent_id),
    market_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    actor_hash TEXT NOT NULL CHECK(length(actor_hash) = 64 AND actor_hash NOT GLOB '*[^0-9a-f]*'),
    listing_id TEXT NOT NULL,
    symbol TEXT NOT NULL CHECK(length(symbol) BETWEEN 1 AND 12 AND symbol NOT GLOB '*[^A-Z0-9]*'),
    side TEXT NOT NULL CHECK(side IN ('BUY','SELL')),
    price TEXT NOT NULL CHECK(length(price) BETWEEN 1 AND 128),
    quantity TEXT NOT NULL CHECK(length(quantity) BETWEEN 1 AND 128),
    gross_numerator TEXT NOT NULL CHECK(length(gross_numerator) BETWEEN 1 AND 4096),
    gross_denominator TEXT NOT NULL CHECK(length(gross_denominator) BETWEEN 1 AND 4096),
    fee_numerator TEXT NOT NULL CHECK(length(fee_numerator) BETWEEN 1 AND 4096),
    fee_denominator TEXT NOT NULL CHECK(length(fee_denominator) BETWEEN 1 AND 4096),
    total_atoms TEXT NOT NULL CHECK(length(total_atoms) BETWEEN 1 AND 50 AND total_atoms NOT GLOB '*[^0-9]*'),
    cash_after_atoms TEXT NOT NULL CHECK(length(cash_after_atoms) BETWEEN 1 AND 50 AND cash_after_atoms NOT GLOB '*[^0-9]*'),
    cost_removed_atoms TEXT NOT NULL CHECK(length(cost_removed_atoms) BETWEEN 1 AND 50 AND cost_removed_atoms NOT GLOB '*[^0-9]*'),
    realized_pnl_atoms TEXT NOT NULL CHECK(length(realized_pnl_atoms) BETWEEN 1 AND 51),
    rounding_numerator TEXT NOT NULL CHECK(length(rounding_numerator) BETWEEN 1 AND 4096),
    rounding_denominator TEXT NOT NULL CHECK(length(rounding_denominator) BETWEEN 1 AND 4096),
    tick_no INTEGER NOT NULL CHECK(tick_no BETWEEN 0 AND 9007199254740991),
    market_version INTEGER NOT NULL CHECK(market_version BETWEEN 0 AND 9007199254740991),
    sequence_no INTEGER NOT NULL CHECK(sequence_no BETWEEN 1 AND 9007199254740991),
    engine_version TEXT NOT NULL,
    ruleset_version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(market_id,account_id,order_id) REFERENCES orders(market_id,account_id,order_id),
    FOREIGN KEY(market_id,account_id) REFERENCES accounts(market_id,account_id),
    FOREIGN KEY(market_id,listing_id) REFERENCES listings(market_id,listing_id)
  ) STRICT;
  CREATE INDEX fills_owner_sequence ON fills(market_id,actor_hash,sequence_no DESC);
  CREATE TRIGGER fills_no_update BEFORE UPDATE ON fills BEGIN SELECT RAISE(ABORT, 'append-only record'); END;
  CREATE TRIGGER fills_no_delete BEFORE DELETE ON fills BEGIN SELECT RAISE(ABORT, 'append-only record'); END;

  CREATE TABLE trade_commands (
    interaction_id TEXT PRIMARY KEY CHECK(length(interaction_id) BETWEEN 17 AND 20 AND interaction_id NOT GLOB '*[^0-9]*'),
    guild_id TEXT NOT NULL,
    actor_hash TEXT NOT NULL CHECK(length(actor_hash) = 64 AND actor_hash NOT GLOB '*[^0-9a-f]*'),
    command_type TEXT NOT NULL CHECK(length(command_type) BETWEEN 1 AND 32),
    payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
    response_json TEXT NOT NULL CHECK(length(response_json) BETWEEN 1 AND 32768 AND json_valid(response_json)),
    received_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TRIGGER trade_commands_no_update BEFORE UPDATE ON trade_commands BEGIN SELECT RAISE(ABORT, 'append-only record'); END;
  CREATE TRIGGER trade_commands_no_delete BEFORE DELETE ON trade_commands
    WHEN NOT EXISTS (SELECT 1 FROM account_subjects s WHERE s.subject_hash = OLD.actor_hash AND s.closed_at IS NOT NULL)
    BEGIN SELECT RAISE(ABORT, 'append-only record'); END;

  CREATE TABLE trial_ticks (
    market_id TEXT NOT NULL REFERENCES markets(market_id),
    tick_no INTEGER NOT NULL CHECK(tick_no BETWEEN 1 AND 9007199254740991),
    market_version INTEGER NOT NULL CHECK(market_version BETWEEN 1 AND 9007199254740991),
    sequence_no INTEGER NOT NULL CHECK(sequence_no BETWEEN 1 AND 9007199254740991),
    boundary_at TEXT NOT NULL,
    committed_at TEXT NOT NULL,
    PRIMARY KEY(market_id,tick_no),
    UNIQUE(market_id,market_version),
    UNIQUE(market_id,sequence_no)
  ) STRICT;
  CREATE TRIGGER trial_ticks_no_update BEFORE UPDATE ON trial_ticks BEGIN SELECT RAISE(ABORT, 'append-only record'); END;
  CREATE TRIGGER trial_ticks_no_delete BEFORE DELETE ON trial_ticks BEGIN SELECT RAISE(ABORT, 'append-only record'); END;
  PRAGMA user_version = 2;
`;

const economySql = `
  CREATE TABLE market_settings_next (
    market_id TEXT PRIMARY KEY REFERENCES markets(market_id),
    market_channel_id TEXT NOT NULL CHECK(length(market_channel_id) BETWEEN 17 AND 20 AND market_channel_id NOT GLOB '*[^0-9]*'),
    board_message_id TEXT CHECK(board_message_id IS NULL OR (length(board_message_id) BETWEEN 17 AND 20 AND board_message_id NOT GLOB '*[^0-9]*')),
    quote_provider TEXT NOT NULL CHECK(quote_provider IN ('STATIC_TRIAL','ECONOMY')),
    configured_at TEXT NOT NULL,
    checkpoint_at TEXT NOT NULL,
    remaining_ms INTEGER NOT NULL CHECK(remaining_ms BETWEEN 0 AND 300000)
  ) STRICT;
  INSERT INTO market_settings_next SELECT * FROM market_settings;
  DROP TABLE market_settings;
  ALTER TABLE market_settings_next RENAME TO market_settings;

  CREATE TABLE economy_markets (
    market_id TEXT PRIMARY KEY REFERENCES markets(market_id),
    epoch_tick INTEGER NOT NULL CHECK(epoch_tick BETWEEN 0 AND 9007199254740991),
    current_tick INTEGER NOT NULL CHECK(current_tick BETWEEN 0 AND 9007199254740991),
    seed_check TEXT NOT NULL CHECK(length(seed_check) = 64 AND seed_check NOT GLOB '*[^0-9a-f]*'),
    current_hash TEXT NOT NULL CHECK(length(current_hash) = 64 AND current_hash NOT GLOB '*[^0-9a-f]*'),
    initialized_at TEXT NOT NULL,
    CHECK(current_tick >= epoch_tick)
  ) STRICT;
  CREATE TRIGGER economy_markets_identity_immutable BEFORE UPDATE OF market_id,epoch_tick,seed_check,initialized_at ON economy_markets
    BEGIN SELECT RAISE(ABORT, 'economy identity is immutable'); END;
  CREATE TRIGGER economy_markets_no_delete BEFORE DELETE ON economy_markets
    BEGIN SELECT RAISE(ABORT, 'economy state cannot be reset'); END;

  CREATE TABLE economy_snapshots (
    market_id TEXT NOT NULL REFERENCES markets(market_id),
    tick_no INTEGER NOT NULL CHECK(tick_no BETWEEN 0 AND 9007199254740991),
    engine_tick INTEGER NOT NULL CHECK(engine_tick BETWEEN 0 AND 9007199254740991),
    market_version INTEGER NOT NULL CHECK(market_version BETWEEN 0 AND 9007199254740991),
    engine_version TEXT NOT NULL,
    snapshot_json TEXT NOT NULL CHECK(length(snapshot_json) BETWEEN 1 AND 4194304 AND json_valid(snapshot_json)),
    snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash) = 64 AND snapshot_hash NOT GLOB '*[^0-9a-f]*'),
    boundary_at TEXT NOT NULL,
    committed_at TEXT NOT NULL,
    PRIMARY KEY(market_id,tick_no)
  ) STRICT;
  CREATE TRIGGER economy_snapshots_no_update BEFORE UPDATE ON economy_snapshots BEGIN SELECT RAISE(ABORT, 'append-only record'); END;
  CREATE TRIGGER economy_snapshots_no_delete BEFORE DELETE ON economy_snapshots BEGIN SELECT RAISE(ABORT, 'append-only record'); END;

  CREATE TABLE corporate_journal (
    market_id TEXT NOT NULL,
    tick_no INTEGER NOT NULL,
    entry_index INTEGER NOT NULL CHECK(entry_index BETWEEN 0 AND 65535),
    issuer_id TEXT NOT NULL,
    entry_json TEXT NOT NULL CHECK(length(entry_json) BETWEEN 1 AND 262144 AND json_valid(entry_json)),
    PRIMARY KEY(market_id,tick_no,entry_index),
    FOREIGN KEY(market_id,tick_no) REFERENCES economy_snapshots(market_id,tick_no),
    FOREIGN KEY(market_id,issuer_id) REFERENCES issuers(market_id,issuer_id)
  ) STRICT;
  CREATE TRIGGER corporate_journal_no_update BEFORE UPDATE ON corporate_journal BEGIN SELECT RAISE(ABORT, 'append-only record'); END;
  CREATE TRIGGER corporate_journal_no_delete BEFORE DELETE ON corporate_journal BEGIN SELECT RAISE(ABORT, 'append-only record'); END;

  CREATE TABLE economy_publications (
    market_id TEXT NOT NULL,
    tick_no INTEGER NOT NULL,
    publication_id TEXT NOT NULL CHECK(length(publication_id) BETWEEN 1 AND 128),
    publication_json TEXT NOT NULL CHECK(length(publication_json) BETWEEN 1 AND 262144 AND json_valid(publication_json)),
    PRIMARY KEY(market_id,publication_id),
    FOREIGN KEY(market_id,tick_no) REFERENCES economy_snapshots(market_id,tick_no)
  ) STRICT;
  CREATE TRIGGER economy_publications_no_update BEFORE UPDATE ON economy_publications BEGIN SELECT RAISE(ABORT, 'append-only record'); END;
  CREATE TRIGGER economy_publications_no_delete BEFORE DELETE ON economy_publications BEGIN SELECT RAISE(ABORT, 'append-only record'); END;

  CREATE TABLE economy_prices (
    market_id TEXT NOT NULL,
    tick_no INTEGER NOT NULL,
    listing_id TEXT NOT NULL,
    price TEXT NOT NULL CHECK(length(price) BETWEEN 1 AND 128),
    contribution_json TEXT NOT NULL CHECK(length(contribution_json) BETWEEN 1 AND 262144 AND json_valid(contribution_json)),
    PRIMARY KEY(market_id,tick_no,listing_id),
    FOREIGN KEY(market_id,tick_no) REFERENCES economy_snapshots(market_id,tick_no),
    FOREIGN KEY(market_id,listing_id) REFERENCES listings(market_id,listing_id)
  ) STRICT;
  CREATE TRIGGER economy_prices_no_update BEFORE UPDATE ON economy_prices BEGIN SELECT RAISE(ABORT, 'append-only record'); END;
  CREATE TRIGGER economy_prices_no_delete BEFORE DELETE ON economy_prices BEGIN SELECT RAISE(ABORT, 'append-only record'); END;

  CREATE TABLE economy_rate_intervals (
    market_id TEXT NOT NULL,
    tick_no INTEGER NOT NULL,
    daily_cash_rate TEXT NOT NULL CHECK(length(daily_cash_rate) BETWEEN 1 AND 128),
    rate_json TEXT NOT NULL CHECK(length(rate_json) BETWEEN 1 AND 65536 AND json_valid(rate_json)),
    PRIMARY KEY(market_id,tick_no),
    FOREIGN KEY(market_id,tick_no) REFERENCES economy_snapshots(market_id,tick_no)
  ) STRICT;
  CREATE TRIGGER economy_rate_intervals_no_update BEFORE UPDATE ON economy_rate_intervals BEGIN SELECT RAISE(ABORT, 'append-only record'); END;
  CREATE TRIGGER economy_rate_intervals_no_delete BEFORE DELETE ON economy_rate_intervals BEGIN SELECT RAISE(ABORT, 'append-only record'); END;

  CREATE TABLE account_interest (
    market_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    tick_no INTEGER NOT NULL CHECK(tick_no BETWEEN 0 AND 9007199254740991),
    elapsed_ms INTEGER NOT NULL CHECK(elapsed_ms BETWEEN 0 AND 300000),
    cash_atoms TEXT NOT NULL CHECK(length(cash_atoms) BETWEEN 1 AND 50 AND cash_atoms NOT GLOB '*[^0-9]*'),
    accrued_numerator TEXT NOT NULL CHECK(length(accrued_numerator) BETWEEN 1 AND 4096),
    accrued_denominator TEXT NOT NULL CHECK(length(accrued_denominator) BETWEEN 1 AND 4096),
    carry_numerator TEXT NOT NULL CHECK(length(carry_numerator) BETWEEN 1 AND 4096),
    carry_denominator TEXT NOT NULL CHECK(length(carry_denominator) BETWEEN 1 AND 4096),
    state_hash TEXT NOT NULL CHECK(length(state_hash) = 64 AND state_hash NOT GLOB '*[^0-9a-f]*'),
    PRIMARY KEY(market_id,account_id),
    FOREIGN KEY(market_id,account_id) REFERENCES accounts(market_id,account_id)
  ) STRICT;
  CREATE TRIGGER account_interest_identity_immutable BEFORE UPDATE OF market_id,account_id ON account_interest
    BEGIN SELECT RAISE(ABORT, 'interest identity is immutable'); END;
  CREATE TRIGGER account_interest_no_delete BEFORE DELETE ON account_interest
    BEGIN SELECT RAISE(ABORT, 'interest state cannot be reset'); END;

  CREATE TABLE interest_payouts (
    market_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    tick_no INTEGER NOT NULL,
    paid_atoms TEXT NOT NULL CHECK(length(paid_atoms) BETWEEN 1 AND 50 AND paid_atoms NOT GLOB '*[^0-9]*'),
    accrued_numerator TEXT NOT NULL CHECK(length(accrued_numerator) BETWEEN 1 AND 4096),
    accrued_denominator TEXT NOT NULL CHECK(length(accrued_denominator) BETWEEN 1 AND 4096),
    carry_numerator TEXT NOT NULL CHECK(length(carry_numerator) BETWEEN 1 AND 4096),
    carry_denominator TEXT NOT NULL CHECK(length(carry_denominator) BETWEEN 1 AND 4096),
    sequence_no INTEGER NOT NULL CHECK(sequence_no BETWEEN 1 AND 9007199254740991),
    created_at TEXT NOT NULL,
    PRIMARY KEY(market_id,account_id,tick_no),
    FOREIGN KEY(market_id,account_id) REFERENCES accounts(market_id,account_id)
  ) STRICT;
  CREATE TRIGGER interest_payouts_no_update BEFORE UPDATE ON interest_payouts BEGIN SELECT RAISE(ABORT, 'append-only record'); END;
  CREATE TRIGGER interest_payouts_no_delete BEFORE DELETE ON interest_payouts BEGIN SELECT RAISE(ABORT, 'append-only record'); END;
  PRAGMA user_version = 3;
`;

const rightsSql = `
  CREATE TABLE corporate_actions (
    market_id TEXT NOT NULL REFERENCES markets(market_id),
    action_id TEXT NOT NULL,
    tick_no INTEGER NOT NULL,
    action_json TEXT NOT NULL CHECK(length(action_json) BETWEEN 1 AND 262144 AND json_valid(action_json)),
    PRIMARY KEY(market_id,action_id),
    FOREIGN KEY(market_id,tick_no) REFERENCES economy_snapshots(market_id,tick_no)
  ) STRICT;
  CREATE TRIGGER corporate_actions_no_update BEFORE UPDATE ON corporate_actions BEGIN SELECT RAISE(ABORT, 'append-only record'); END;
  CREATE TRIGGER corporate_actions_no_delete BEFORE DELETE ON corporate_actions BEGIN SELECT RAISE(ABORT, 'append-only record'); END;
  CREATE TABLE rights_journal (
    market_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    right_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    tick_no INTEGER NOT NULL CHECK(tick_no BETWEEN 0 AND 9007199254740991),
    market_version INTEGER NOT NULL CHECK(market_version BETWEEN 0 AND 9007199254740991),
    sequence_no INTEGER NOT NULL CHECK(sequence_no BETWEEN 1 AND 9007199254740991),
    state_json TEXT NOT NULL CHECK(length(state_json) BETWEEN 1 AND 262144 AND json_valid(state_json)),
    counter_json TEXT NOT NULL CHECK(length(counter_json) BETWEEN 1 AND 262144 AND json_valid(counter_json)),
    previous_hash TEXT NOT NULL,
    state_hash TEXT NOT NULL CHECK(length(state_hash)=64),
    created_at TEXT NOT NULL,
    PRIMARY KEY(market_id,account_id,right_id,action_id),
    UNIQUE(event_id),
    FOREIGN KEY(market_id,account_id) REFERENCES accounts(market_id,account_id)
  ) STRICT;
  CREATE INDEX rights_journal_replay ON rights_journal(market_id,account_id,sequence_no);
  CREATE TRIGGER rights_journal_no_update BEFORE UPDATE ON rights_journal BEGIN SELECT RAISE(ABORT, 'append-only record'); END;
  CREATE TRIGGER rights_journal_no_delete BEFORE DELETE ON rights_journal BEGIN SELECT RAISE(ABORT, 'append-only record'); END;
  CREATE TABLE corporate_order_cancellations (
    market_id TEXT NOT NULL, account_id TEXT NOT NULL, intent_id TEXT NOT NULL,
    action_id TEXT NOT NULL, reason TEXT NOT NULL CHECK(reason='CORPORATE_ACTION_CANCELLED'),
    PRIMARY KEY(market_id,intent_id),
    FOREIGN KEY(market_id,account_id) REFERENCES accounts(market_id,account_id),
    FOREIGN KEY(intent_id) REFERENCES order_intents(intent_id)
  ) STRICT;
  CREATE TRIGGER corporate_cancellations_no_update BEFORE UPDATE ON corporate_order_cancellations BEGIN SELECT RAISE(ABORT, 'append-only record'); END;
  CREATE TRIGGER corporate_cancellations_no_delete BEFORE DELETE ON corporate_order_cancellations BEGIN SELECT RAISE(ABORT, 'append-only record'); END;
  PRAGMA user_version = 4;
`;

const scheduledSql = `
  CREATE TABLE conditional_intents (
    intent_id TEXT PRIMARY KEY REFERENCES order_intents(intent_id) ON DELETE CASCADE,
    order_type TEXT NOT NULL CHECK(order_type IN ('LIMIT','STOP')),
    condition_price TEXT NOT NULL CHECK(length(condition_price) BETWEEN 1 AND 128),
    time_in_force TEXT NOT NULL CHECK(time_in_force IN ('TICK_COUNT','UNTIL_CANCELLED')),
    valid_for_ticks INTEGER CHECK(valid_for_ticks BETWEEN 1 AND 10000),
    CHECK((time_in_force='TICK_COUNT' AND valid_for_ticks IS NOT NULL) OR (time_in_force='UNTIL_CANCELLED' AND valid_for_ticks IS NULL))
  ) STRICT;
  CREATE TRIGGER conditional_intents_no_update BEFORE UPDATE ON conditional_intents BEGIN SELECT RAISE(ABORT,'immutable conditional intent'); END;
  CREATE TABLE scheduled_orders (
    order_id TEXT PRIMARY KEY,
    intent_id TEXT NOT NULL UNIQUE REFERENCES order_intents(intent_id),
    market_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    actor_hash TEXT NOT NULL CHECK(length(actor_hash)=64),
    listing_id TEXT NOT NULL,
    symbol TEXT NOT NULL CHECK(length(symbol) BETWEEN 1 AND 12),
    side TEXT NOT NULL CHECK(side IN ('BUY','SELL')),
    order_type TEXT NOT NULL CHECK(order_type IN ('LIMIT','STOP') AND (order_type<>'STOP' OR side='SELL')),
    quantity TEXT NOT NULL CHECK(length(quantity) BETWEEN 1 AND 128),
    condition_price TEXT NOT NULL CHECK(length(condition_price) BETWEEN 1 AND 128),
    time_in_force TEXT NOT NULL CHECK(time_in_force IN ('TICK_COUNT','UNTIL_CANCELLED')),
    expires_tick INTEGER CHECK(expires_tick BETWEEN 1 AND 9007199254740991),
    created_tick INTEGER NOT NULL CHECK(created_tick BETWEEN 0 AND 9007199254740991),
    sequence_no INTEGER NOT NULL CHECK(sequence_no BETWEEN 1 AND 9007199254740991),
    reserved_cash_atoms TEXT NOT NULL CHECK(length(reserved_cash_atoms) BETWEEN 1 AND 50 AND reserved_cash_atoms NOT GLOB '*[^0-9]*'),
    reserved_quantity TEXT NOT NULL CHECK(length(reserved_quantity) BETWEEN 1 AND 128),
    status TEXT NOT NULL CHECK(status IN ('OPEN','FILLED','CANCELLED','EXPIRED')),
    termination_reason TEXT CHECK(termination_reason IN ('USER_CANCELLED','EXPIRED','CORPORATE_ACTION_CANCELLED','ACCOUNT_CLOSED','FILLED')),
    fill_order_id TEXT REFERENCES orders(order_id),
    created_at TEXT NOT NULL,
    FOREIGN KEY(market_id,account_id,intent_id) REFERENCES order_intents(market_id,account_id,intent_id),
    FOREIGN KEY(market_id,account_id) REFERENCES accounts(market_id,account_id),
    FOREIGN KEY(market_id,listing_id) REFERENCES listings(market_id,listing_id),
    UNIQUE(market_id,sequence_no),
    CHECK((time_in_force='TICK_COUNT' AND expires_tick>created_tick) OR (time_in_force='UNTIL_CANCELLED' AND expires_tick IS NULL)),
    CHECK((status='OPEN' AND termination_reason IS NULL AND fill_order_id IS NULL) OR
      (status='FILLED' AND termination_reason='FILLED' AND fill_order_id IS NOT NULL) OR
      (status IN ('CANCELLED','EXPIRED') AND termination_reason IS NOT NULL AND fill_order_id IS NULL))
  ) STRICT;
  CREATE INDEX scheduled_orders_owner ON scheduled_orders(market_id,account_id,status,sequence_no);
  CREATE TRIGGER scheduled_orders_no_delete BEFORE DELETE ON scheduled_orders BEGIN SELECT RAISE(ABORT,'persistent scheduled order'); END;
  CREATE TRIGGER scheduled_orders_terms_immutable BEFORE UPDATE ON scheduled_orders
    WHEN NEW.order_id<>OLD.order_id OR NEW.intent_id<>OLD.intent_id OR NEW.market_id<>OLD.market_id OR NEW.account_id<>OLD.account_id OR
      NEW.actor_hash<>OLD.actor_hash OR NEW.listing_id<>OLD.listing_id OR NEW.symbol<>OLD.symbol OR NEW.side<>OLD.side OR
      NEW.order_type<>OLD.order_type OR NEW.quantity<>OLD.quantity OR NEW.condition_price<>OLD.condition_price OR
      NEW.time_in_force<>OLD.time_in_force OR NEW.expires_tick IS NOT OLD.expires_tick OR NEW.created_tick<>OLD.created_tick OR
      NEW.sequence_no<>OLD.sequence_no OR NEW.reserved_cash_atoms<>OLD.reserved_cash_atoms OR NEW.reserved_quantity<>OLD.reserved_quantity OR
      NEW.created_at<>OLD.created_at OR OLD.status<>'OPEN' OR NEW.status='OPEN'
    BEGIN SELECT RAISE(ABORT,'immutable scheduled order terms or termination'); END;
  CREATE TRIGGER conditional_intents_no_delete BEFORE DELETE ON conditional_intents
    WHEN EXISTS(SELECT 1 FROM scheduled_orders WHERE intent_id=OLD.intent_id)
    BEGIN SELECT RAISE(ABORT,'confirmed conditional terms cannot be deleted'); END;
  CREATE TABLE reservation_journal (
    event_id TEXT PRIMARY KEY,
    market_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    order_id TEXT NOT NULL REFERENCES scheduled_orders(order_id),
    tick_no INTEGER NOT NULL CHECK(tick_no BETWEEN 0 AND 9007199254740991),
    market_version INTEGER NOT NULL CHECK(market_version BETWEEN 0 AND 9007199254740991),
    sequence_no INTEGER NOT NULL CHECK(sequence_no BETWEEN 1 AND 9007199254740991),
    state_json TEXT NOT NULL CHECK(length(state_json) BETWEEN 1 AND 32768 AND json_valid(state_json)),
    cash_delta_atoms TEXT NOT NULL,
    system_cash_delta_atoms TEXT NOT NULL,
    quantity_delta TEXT NOT NULL,
    system_quantity_delta TEXT NOT NULL,
    previous_hash TEXT NOT NULL,
    state_hash TEXT NOT NULL CHECK(length(state_hash)=64),
    created_at TEXT NOT NULL,
    FOREIGN KEY(market_id,account_id) REFERENCES accounts(market_id,account_id)
  ) STRICT;
  CREATE INDEX reservation_journal_replay ON reservation_journal(market_id,account_id,sequence_no);
  CREATE TRIGGER reservation_journal_no_update BEFORE UPDATE ON reservation_journal BEGIN SELECT RAISE(ABORT,'append-only record'); END;
  CREATE TRIGGER reservation_journal_no_delete BEFORE DELETE ON reservation_journal BEGIN SELECT RAISE(ABORT,'append-only record'); END;
  PRAGMA user_version=5;
`;

export const migrations: readonly Migration[] = Object.freeze([
  Object.freeze({ version: 1, name: 'foundation', sql: foundationSql }),
  Object.freeze({ version: 2, name: 'broker', sql: brokerSql }),
  Object.freeze({ version: 3, name: 'economy', sql: economySql }),
  Object.freeze({ version: 4, name: 'corporate-rights', sql: rightsSql }),
  Object.freeze({ version: 5, name: 'conditional-orders', sql: scheduledSql }),
  Object.freeze({ version: 6, name: 'reporting-notifications', sql: benchmarkSchemaSql + reportingSchemaSql + notificationSchemaSql + '\nPRAGMA user_version=6;\n' }),
]);

export class MigrationIntegrityError extends Error {
  constructor(message = 'Database migration history does not match this application.') {
    super(message);
    this.name = 'MigrationIntegrityError';
  }
}

export function migrationChecksum(migration: Migration): string {
  return createHash('sha256').update(JSON.stringify([migration.version, migration.name, migration.sql])).digest('hex');
}

/** All migration work, including history bootstrap, succeeds or rolls back together. */
export function migrateDatabase(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY CHECK(version > 0),
      name TEXT NOT NULL,
      checksum TEXT NOT NULL CHECK(length(checksum) = 64),
      applied_at TEXT NOT NULL
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS schema_migrations_no_update BEFORE UPDATE ON schema_migrations
      BEGIN SELECT RAISE(ABORT, 'append-only migration history'); END;
    CREATE TRIGGER IF NOT EXISTS schema_migrations_no_delete BEFORE DELETE ON schema_migrations
      BEGIN SELECT RAISE(ABORT, 'append-only migration history'); END;`);

    const applied = db.prepare('SELECT version,name,checksum FROM schema_migrations ORDER BY version').all() as Array<{
      version: number; name: string; checksum: string;
    }>;
    if (applied.length > migrations.length) throw new MigrationIntegrityError();
    for (const [index, row] of applied.entries()) {
      const expected = migrations[index];
      if (!expected || row.version !== expected.version || row.name !== expected.name || row.checksum !== migrationChecksum(expected)) {
        throw new MigrationIntegrityError();
      }
    }
    const currentVersion = db.pragma('user_version', { simple: true });
    if (currentVersion !== (applied.at(-1)?.version ?? 0)) throw new MigrationIntegrityError();

    const insert = db.prepare('INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES(?,?,?,?)');
    for (const migration of migrations.slice(applied.length)) {
      db.exec(migration.sql);
      insert.run(migration.version, migration.name, migrationChecksum(migration), new Date().toISOString());
    }
  }).immediate();
}

/** Detect removed or altered constraints, tables, indexes and append-only triggers on restart. */
export function verifyDatabaseSchema(db: Database.Database): void {
  const expected = new Database(':memory:');
  try {
    migrateDatabase(expected);
    const query = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
    if (JSON.stringify(db.prepare(query).all()) !== JSON.stringify(expected.prepare(query).all())) {
      throw new MigrationIntegrityError('Database schema differs from the verified migrations.');
    }
  } finally {
    expected.close();
  }
}
