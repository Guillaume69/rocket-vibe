-- Terminal original intentions. Cancelling never removes an accepted backup.
CREATE TABLE e2ee_root_backup_cancellations (
    user_id TEXT NOT NULL REFERENCES users(id),
    device_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    receipt JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(user_id,device_id,operation_id)
);
CREATE INDEX e2ee_root_backup_cancellations_quota ON e2ee_root_backup_cancellations(user_id,device_id,created_at);
