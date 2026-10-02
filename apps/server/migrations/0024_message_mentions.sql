-- Resolved at first send. Edits can withdraw a mention, never add a new ping.
CREATE TABLE message_mentions (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('direct','all','here')),
    token TEXT NOT NULL,
    PRIMARY KEY(message_id,user_id,kind)
);
CREATE INDEX message_mentions_user ON message_mentions(user_id,message_id) INCLUDE(kind);

