CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  workshop_id TEXT NOT NULL,
  starts_at TEXT NOT NULL CHECK (length(starts_at) = 24 AND substr(starts_at, 24, 1) = 'Z'),
  ends_at TEXT NOT NULL CHECK (length(ends_at) = 24 AND ends_at > starts_at),
  capacity INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 20),
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled')),
  created_at TEXT NOT NULL,
  UNIQUE (workshop_id, starts_at)
) STRICT;

CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  unit_price_kopecks INTEGER NOT NULL CHECK (unit_price_kopecks > 0),
  total_kopecks INTEGER NOT NULL CHECK (total_kopecks = unit_price_kopecks * quantity),
  customer_name TEXT NOT NULL CHECK (length(customer_name) BETWEEN 1 AND 100),
  phone TEXT NOT NULL CHECK (length(phone) BETWEEN 7 AND 25),
  email TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  comment TEXT NOT NULL DEFAULT '' CHECK (length(comment) <= 1000),
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  management_token_hash TEXT NOT NULL UNIQUE CHECK (length(management_token_hash) = 64),
  consent_version TEXT NOT NULL,
  consent_at TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 1 CHECK (is_demo IN (0, 1)),
  created_at TEXT NOT NULL,
  cancelled_at TEXT,
  CHECK ((status = 'confirmed' AND cancelled_at IS NULL) OR (status = 'cancelled' AND cancelled_at IS NOT NULL))
) STRICT;

CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE app_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE INDEX sessions_by_start ON sessions(starts_at);
CREATE INDEX bookings_by_session_status ON bookings(session_id, status);

-- База дополнительно защищает вместимость даже при ошибке вызывающего кода.
CREATE TRIGGER bookings_capacity_insert BEFORE INSERT ON bookings
WHEN NEW.status = 'confirmed'
BEGIN
  SELECT CASE WHEN
    NEW.quantity + COALESCE((SELECT SUM(quantity) FROM bookings WHERE session_id = NEW.session_id AND status = 'confirmed'), 0)
    > (SELECT capacity FROM sessions WHERE id = NEW.session_id)
    THEN RAISE(ABORT, 'CAPACITY_EXCEEDED') END;
END;

CREATE TRIGGER bookings_capacity_update BEFORE UPDATE OF quantity, session_id, status ON bookings
WHEN NEW.status = 'confirmed'
BEGIN
  SELECT CASE WHEN
    NEW.quantity + COALESCE((SELECT SUM(quantity) FROM bookings WHERE session_id = NEW.session_id AND status = 'confirmed' AND id != OLD.id), 0)
    > (SELECT capacity FROM sessions WHERE id = NEW.session_id)
    THEN RAISE(ABORT, 'CAPACITY_EXCEEDED') END;
END;

CREATE TRIGGER sessions_capacity_update BEFORE UPDATE OF capacity ON sessions
BEGIN
  SELECT CASE WHEN NEW.capacity < COALESCE((SELECT SUM(quantity) FROM bookings WHERE session_id = OLD.id AND status = 'confirmed'), 0)
    THEN RAISE(ABORT, 'CAPACITY_BELOW_BOOKED') END;
END;
