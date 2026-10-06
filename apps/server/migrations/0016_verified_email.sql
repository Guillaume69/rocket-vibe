-- Private contact authority is separate from login credentials and factors.
ALTER TABLE users ADD COLUMN email_version text NOT NULL DEFAULT gen_random_uuid()::text;
ALTER TABLE session_devices ADD COLUMN email_verification_version text NOT NULL DEFAULT gen_random_uuid()::text;
CREATE TABLE account_emails (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  address text NOT NULL CHECK (octet_length(address) BETWEEN 3 AND 254),
  verified_at timestamptz NOT NULL
);
CREATE TABLE email_verifications (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES session_devices(id) ON DELETE CASCADE,
  operation_id text NOT NULL,
  instance_id text NOT NULL,
  data_epoch text NOT NULL,
  activation_version text NOT NULL,
  factor_version text NOT NULL,
  email_version text NOT NULL,
  requested_version text NOT NULL,
  committed_version text,
  committed_head text,
  address text NOT NULL CHECK (octet_length(address) BETWEEN 3 AND 254),
  code_hash text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  receipt_expires_at timestamptz,
  UNIQUE(device_id,operation_id),
  UNIQUE(device_id,requested_version),
  CHECK ((verified_at IS NULL) = (committed_version IS NULL)),
  CHECK ((verified_at IS NULL) = (committed_head IS NULL)),
  CHECK ((verified_at IS NULL) = (receipt_expires_at IS NULL))
);
CREATE INDEX email_verifications_expiry ON email_verifications(expires_at);
CREATE TABLE email_outbox (
  id text PRIMARY KEY,
  verification_hash text NOT NULL UNIQUE REFERENCES email_verifications(token_hash) ON DELETE CASCADE,
  payload_cipher bytea,
  expires_at timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 8),
  lease_id text,
  lease_expires_at timestamptz,
  sent_at timestamptz,
  CHECK ((lease_id IS NULL) = (lease_expires_at IS NULL)),
  CHECK (sent_at IS NULL OR payload_cipher IS NULL)
);
CREATE INDEX email_outbox_ready ON email_outbox(next_attempt_at) WHERE sent_at IS NULL AND payload_cipher IS NOT NULL;
CREATE TABLE email_delivery_windows (
  key text PRIMARY KEY,
  attempts integer NOT NULL CHECK (attempts>0),
  expires_at timestamptz NOT NULL
);
-- Admission is durable independently of HTTP cancellation and replayable once.
CREATE TABLE email_delivery_admissions (
  key text PRIMARY KEY CHECK (key ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL
);
