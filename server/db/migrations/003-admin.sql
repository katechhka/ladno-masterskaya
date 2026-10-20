CREATE TABLE workshop_programs (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  data TEXT NOT NULL CHECK (json_valid(data)),
  gallery TEXT NOT NULL CHECK (json_valid(gallery)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
) STRICT;
ALTER TABLE sessions ADD COLUMN booking_open INTEGER NOT NULL DEFAULT 1 CHECK (booking_open IN (0,1));
ALTER TABLE sessions ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE bookings ADD COLUMN notification_required INTEGER NOT NULL DEFAULT 0 CHECK (notification_required IN (0,1));
ALTER TABLE bookings ADD COLUMN change_note TEXT NOT NULL DEFAULT '';
CREATE TABLE admin_owner (
  id INTEGER PRIMARY KEY CHECK (id=1),
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL
) STRICT;
CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;
