ALTER TABLE messages ADD COLUMN previews jsonb NOT NULL DEFAULT '[]';
ALTER TABLE messages ADD COLUMN preview_token text;
CREATE TABLE link_preview_jobs (
    message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    slot smallint NOT NULL CHECK(slot BETWEEN 0 AND 2),
    token text NOT NULL,
    data_epoch text NOT NULL,
    url text NOT NULL CHECK(octet_length(url)<=2048),
    state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','complete','retired')),
    result jsonb,
    attempts smallint NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
    next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '10 minutes',
    lease_id text,
    lease_expires_at timestamptz,
    PRIMARY KEY(message_id,slot)
);
CREATE INDEX link_preview_ready ON link_preview_jobs(next_attempt_at,message_id,slot) WHERE state='pending';
