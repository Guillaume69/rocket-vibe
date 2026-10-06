CREATE TABLE snapshot_budget (
    singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton)
);
INSERT INTO snapshot_budget VALUES (true);

CREATE TABLE snapshot_heads (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    data_epoch TEXT NOT NULL,
    position BIGINT NOT NULL DEFAULT 0,
    room_ids TEXT[] NOT NULL DEFAULT '{}',
    ready BOOLEAN NOT NULL DEFAULT false,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '5 minutes'
);
CREATE INDEX snapshot_heads_user ON snapshot_heads(user_id);
CREATE INDEX snapshot_heads_expiry ON snapshot_heads(expires_at);

CREATE TABLE snapshot_pages (
    token TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL REFERENCES snapshot_heads(id) ON DELETE CASCADE,
    payload JSONB NOT NULL
);
CREATE INDEX snapshot_pages_head ON snapshot_pages(snapshot_id);
