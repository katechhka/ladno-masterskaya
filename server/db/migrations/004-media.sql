CREATE TABLE media_uploads (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data)),
  created_at TEXT NOT NULL
) STRICT;
