-- Receipts are durable domain data. Never prune them as ephemeral cursors.
CREATE TABLE room_creation_requests (
    user_id TEXT NOT NULL REFERENCES users(id),
    operation_id TEXT NOT NULL,
    name TEXT NOT NULL,
    private BOOLEAN NOT NULL,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    PRIMARY KEY(user_id,operation_id)
);
CREATE INDEX rooms_public_directory ON rooms(id) WHERE kind='public';
