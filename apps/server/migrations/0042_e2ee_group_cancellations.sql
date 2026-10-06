-- Personal decisions only: no commit, tree or Welcome is stored on abandonment.
-- Author locking is shared with transition acceptance, including its retry path.
CREATE TABLE e2ee_group_cancellations (
    user_id TEXT NOT NULL REFERENCES users(id),
    device_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    receipt JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(user_id,device_id,operation_id)
);
CREATE INDEX e2ee_group_cancellation_budget ON e2ee_group_cancellations(user_id,created_at);
