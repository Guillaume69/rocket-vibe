-- Only authored plaintext is indexed, never personalized quote excerpts.
ALTER TABLE messages ADD COLUMN search_vector TSVECTOR
    GENERATED ALWAYS AS (to_tsvector('simple'::regconfig,
        CASE WHEN deleted OR system IS NOT NULL THEN '' ELSE text END)) STORED;
CREATE INDEX messages_search ON messages USING GIN(search_vector)
    WHERE NOT deleted AND system IS NULL;
CREATE UNLOGGED TABLE search_windows (
    device_id TEXT PRIMARY KEY REFERENCES session_devices(id) ON DELETE CASCADE,
    attempts INTEGER NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX search_windows_expiration ON search_windows(expires_at);
