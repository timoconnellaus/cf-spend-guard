-- Usage per 5-minute bucket. bucket = bucket start, epoch milliseconds.
CREATE TABLE samples (
  bucket INTEGER NOT NULL,
  product TEXT NOT NULL,
  resource TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  cost REAL NOT NULL,
  PRIMARY KEY (bucket, product, resource, metric)
);
CREATE INDEX samples_series ON samples (product, resource, metric, bucket);

-- One row per collected bucket, so missing samples can be read as zero usage.
CREATE TABLE runs (
  bucket INTEGER PRIMARY KEY,
  ran_at INTEGER NOT NULL,
  total_cost REAL NOT NULL,
  sample_count INTEGER NOT NULL,
  errors TEXT
);

-- Last time each alert key was sent, for cooldowns.
CREATE TABLE alert_state (
  key TEXT PRIMARY KEY,
  last_sent INTEGER NOT NULL
);

-- Alert and kill-switch history shown by /api/status.
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  severity TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX events_at ON events (at);

-- Workers paused by the kill switch, with what is needed to restore them.
CREATE TABLE paused (
  script TEXT PRIMARY KEY,
  paused_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  snapshot TEXT NOT NULL
);
