CREATE TABLE telegram_confirmations (
  booking_id TEXT PRIMARY KEY REFERENCES bookings(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','unknown')),
  chat_id TEXT,
  message_id TEXT,
  error_code TEXT,
  updated_at TEXT NOT NULL
) STRICT;
