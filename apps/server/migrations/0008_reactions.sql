CREATE TABLE message_reactions (
    message_id TEXT NOT NULL REFERENCES messages(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    emoji TEXT NOT NULL,
    PRIMARY KEY(message_id,user_id,emoji)
);
CREATE INDEX message_reaction_groups ON message_reactions(message_id,emoji,user_id);
CREATE TABLE message_action_windows (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    attempts INTEGER NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);
