ALTER TABLE sync_cursors ADD COLUMN expires_at TIMESTAMPTZ NOT NULL
    DEFAULT (now() + interval '7 days');
CREATE INDEX sync_cursors_expiry ON sync_cursors(expires_at);
CREATE INDEX sync_cursors_recent ON sync_cursors(user_id, expires_at DESC, position DESC);
CREATE INDEX socket_tickets_expiry ON socket_tickets(expires_at);
CREATE INDEX socket_tickets_session ON socket_tickets(session_hash);
CREATE INDEX sessions_expiry ON sessions(expires_at);

-- Shared by server processes and preserved across restarts. Only hashes of
-- usernames / peer IPs are stored, never passwords or bearer tokens.
CREATE TABLE login_windows (
    key TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL CHECK (attempts > 0),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX login_windows_expiry ON login_windows(expires_at);
