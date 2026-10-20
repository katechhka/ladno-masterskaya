CREATE TABLE request_limits (
  key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
) STRICT;
CREATE INDEX request_limits_by_reset ON request_limits(reset_at);
