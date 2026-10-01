-- Private, immutable removal receipts contain no former email address.
CREATE TABLE email_removals (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES session_devices(id) ON DELETE CASCADE,
  operation_hash text NOT NULL CHECK (operation_hash ~ '^[0-9a-f]{64}$'),
  instance_id text NOT NULL,
  data_epoch text NOT NULL,
  activation_version text NOT NULL,
  factor_version text NOT NULL,
  expected_version text NOT NULL,
  requested_head text NOT NULL,
  committed_version text NOT NULL,
  committed_head text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(device_id,operation_hash)
);
CREATE INDEX email_removals_expiry ON email_removals(expires_at);
