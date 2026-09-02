-- Pure Light Electric fleet tracker — D1 schema
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS vehicles (
  imei             TEXT PRIMARY KEY,
  monday_item_id   TEXT,
  vin              TEXT,
  label            TEXT,
  status           TEXT DEFAULT 'Active',
  odometer         REAL,
  odometer_at      TEXT,
  mil_on           INTEGER DEFAULT 0,
  dtc_codes        TEXT,
  battery          TEXT,
  connected        INTEGER DEFAULT 1,
  disconnected_at  TEXT,
  last_trip_at     TEXT,
  driver_phone     TEXT,
  driver_ids       TEXT,
  tag_expires      TEXT,
  insurance_expires TEXT,
  inspection_due   TEXT,
  updated_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_vehicles_monday ON vehicles(monday_item_id);

-- Webhook idempotency. Bouncie retries on any non-2xx and can deliver out of order.
CREATE TABLE IF NOT EXISTS seen_events (
  key         TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
);

-- Cached copy of the Service Intervals board, refreshed every sweep so the
-- office can change an interval in Monday and have it take effect same-day.
CREATE TABLE IF NOT EXISTS intervals (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  category       TEXT,
  trigger_on     TEXT,
  miles          REAL,
  months         REAL,
  warn_miles     REAL,
  warn_days      REAL,
  applies_to     TEXT,
  owner_ids      TEXT,
  est_cost       REAL,
  active         INTEGER DEFAULT 1,
  watch_date_col TEXT,
  instructions   TEXT,
  synced_at      TEXT
);

-- When each service was last completed, per vehicle. This is the clock.
CREATE TABLE IF NOT EXISTS service_state (
  imei          TEXT NOT NULL,
  interval_id   TEXT NOT NULL,
  last_done_odo REAL,
  last_done_at  TEXT,
  source        TEXT,
  PRIMARY KEY (imei, interval_id)
);

CREATE TABLE IF NOT EXISTS work_orders (
  monday_item_id TEXT PRIMARY KEY,
  imei           TEXT NOT NULL,
  interval_id    TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'open',
  due_odo        REAL,
  due_date       TEXT,
  priority       TEXT,
  opened_at      TEXT,
  closed_at      TEXT
);
-- At most one OPEN work order per vehicle per service. This index is what stops
-- the system from spamming a duplicate oil change every time a truck parks.
CREATE UNIQUE INDEX IF NOT EXISTS uq_open_wo
  ON work_orders(imei, interval_id) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS idx_wo_state ON work_orders(state);

CREATE TABLE IF NOT EXISTS trips (
  transaction_id TEXT PRIMARY KEY,
  imei           TEXT NOT NULL,
  start_at       TEXT,
  end_at         TEXT,
  distance       REAL,
  fuel_consumed  REAL,
  idle_seconds   REAL,
  hard_brake     INTEGER,
  hard_accel     INTEGER,
  max_speed      REAL
);
CREATE INDEX IF NOT EXISTS idx_trips_imei_end ON trips(imei, end_at);

-- Bouncie access token cache + small key/value scratch (digest guard, etc).
CREATE TABLE IF NOT EXISTS kv (
  k          TEXT PRIMARY KEY,
  v          TEXT,
  expires_at TEXT
);

-- Append-only audit trail. Invaluable when someone asks "why did this open?"
CREATE TABLE IF NOT EXISTS audit (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  kind    TEXT NOT NULL,
  imei    TEXT,
  detail  TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at);
