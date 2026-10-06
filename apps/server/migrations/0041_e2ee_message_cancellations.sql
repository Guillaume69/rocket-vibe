-- Personal terminal decisions, serialized by the same author lock as all
-- application/ordinary sends. Original proof/ciphertext need not be retained.
CREATE TABLE e2ee_message_cancellations (
    user_id TEXT NOT NULL REFERENCES users(id),
    operation_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    receipt JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(user_id,operation_id)
);
CREATE INDEX e2ee_cancellation_budget ON e2ee_message_cancellations(user_id,created_at);
