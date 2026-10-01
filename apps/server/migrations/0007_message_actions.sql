ALTER TABLE messages ADD COLUMN deleted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE messages ADD COLUMN edited_at TIMESTAMPTZ;
-- Lazy backfill before the first edit/delete preserves old databases without
-- requiring pgcrypto or retaining deleted plaintext in a receipt.
ALTER TABLE messages ADD COLUMN send_fingerprint TEXT;
CREATE TABLE message_actions (
    user_id TEXT NOT NULL REFERENCES users(id),
    operation_id TEXT NOT NULL,
    command_hash TEXT NOT NULL,
    message_id TEXT NOT NULL REFERENCES messages(id),
    PRIMARY KEY (user_id, operation_id)
);
CREATE INDEX journal_message ON journal(room_id, (change #>> '{data,id}'))
    WHERE change->>'type'='message_upsert';
