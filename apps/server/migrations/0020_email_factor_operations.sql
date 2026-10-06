CREATE TABLE email_factor_changes (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id text REFERENCES session_devices(id) ON DELETE SET NULL,
  operation_hash text NOT NULL CHECK(operation_hash ~ '^[0-9a-f]{64}$'),
  enabled boolean NOT NULL,
  instance_id text NOT NULL,
  data_epoch text NOT NULL,
  email_version text NOT NULL,
  requested_version text,
  committed_version text NOT NULL,
  activation_version text NOT NULL,
  profile_id text,
  receipt_cipher bytea,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  UNIQUE(device_id,operation_hash)
);
CREATE INDEX email_factor_changes_user ON email_factor_changes(user_id,created_at);

CREATE TABLE factor_email_deliveries (
  token_hash text PRIMARY KEY CHECK(token_hash ~ '^[0-9a-f]{64}$'),
  operation_id text NOT NULL,
  user_id text NOT NULL REFERENCES user_email_factors(user_id) ON DELETE CASCADE,
  device_id text REFERENCES session_devices(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK(purpose IN ('login','reauth')),
  challenge_hash text NOT NULL CHECK(challenge_hash ~ '^[0-9a-f]{64}$'),
  instance_id text NOT NULL,
  data_epoch text NOT NULL,
  activation_version text NOT NULL,
  factor_version text NOT NULL,
  email_version text NOT NULL,
  profile_id text NOT NULL,
  proof_version text,
  address text NOT NULL,
  code_hash text NOT NULL CHECK(code_hash ~ '^[0-9a-f]{64}$'),
  payload_cipher bytea,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  UNIQUE(purpose,challenge_hash,operation_id),
  CHECK((purpose='reauth') = (device_id IS NOT NULL)),
  CHECK((purpose='reauth') = (proof_version IS NOT NULL))
);
CREATE INDEX factor_email_deliveries_challenge ON factor_email_deliveries(purpose,challenge_hash,created_at);
CREATE INDEX factor_email_deliveries_expiry ON factor_email_deliveries(expires_at);
CREATE TABLE factor_email_outbox (
  id text PRIMARY KEY,
  delivery_hash text NOT NULL UNIQUE REFERENCES factor_email_deliveries(token_hash) ON DELETE CASCADE,
  payload_cipher bytea,
  expires_at timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 8),
  lease_id text,
  lease_expires_at timestamptz,
  sent_at timestamptz,
  CHECK((lease_id IS NULL)=(lease_expires_at IS NULL)),
  CHECK(sent_at IS NULL OR payload_cipher IS NULL)
);
CREATE INDEX factor_email_outbox_ready ON factor_email_outbox(next_attempt_at)
  WHERE sent_at IS NULL AND payload_cipher IS NOT NULL;

-- A transport claim and its final pre-send read use the same current binding.
-- No account/device/challenge lock is held while transmitting SMTP.
CREATE VIEW current_factor_email_deliveries AS
SELECT v.token_hash
FROM factor_email_deliveries v
JOIN users u ON u.id=v.user_id
JOIN user_email_factors f ON f.user_id=u.id
JOIN account_emails e ON e.user_id=u.id
JOIN instance i ON i.singleton
LEFT JOIN auth_challenges c ON v.purpose='login' AND c.token_hash=v.challenge_hash
LEFT JOIN reauthentication_challenges r ON v.purpose='reauth' AND r.token_hash=v.challenge_hash
LEFT JOIN session_devices d ON d.id=v.device_id
WHERE v.consumed_at IS NULL AND v.expires_at>clock_timestamp()
  AND NOT u.disabled AND v.instance_id=i.instance_id AND v.data_epoch=i.data_epoch
  AND v.activation_version=u.activation_version AND v.factor_version=u.factor_version
  AND v.email_version=u.email_version AND v.email_version=f.email_version
  AND v.profile_id=f.version AND v.address=e.address
  AND (
    (v.purpose='login' AND c.user_id=u.id AND c.data_epoch=v.data_epoch
      AND c.activation_version=v.activation_version AND c.factor_version=v.factor_version
      AND c.accepted_operation IS NULL AND c.attempts<5 AND c.expires_at=v.expires_at)
    OR
    (v.purpose='reauth' AND r.user_id=u.id AND r.device_id=v.device_id
      AND r.instance_id=v.instance_id AND r.data_epoch=v.data_epoch
      AND r.activation_version=v.activation_version AND r.factor_version=v.factor_version
      AND r.requested_version=v.proof_version AND d.reauthentication_version=v.proof_version
      AND r.authenticated_at IS NULL AND r.attempts<5 AND r.expires_at=v.expires_at
      AND EXISTS(SELECT 1 FROM sessions s WHERE s.device_id=d.id AND s.expires_at>clock_timestamp()))
  );
