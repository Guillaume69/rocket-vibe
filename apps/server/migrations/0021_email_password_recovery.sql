-- Mail codes reuse the operator recovery transaction, with extra contact scope.
ALTER TABLE account_recovery_codes ADD COLUMN email_version text;
ALTER TABLE account_recovery_codes ADD COLUMN email_instance_id text;
ALTER TABLE account_recovery_codes ADD CONSTRAINT recovery_email_scope
  CHECK ((email_version IS NULL)=(email_instance_id IS NULL));

-- Every valid anonymous request receives the same acknowledgement. Empty
-- bindings are durable suppressed/unknown requests; replay cannot turn them
-- into a new delivery after a contact or quota changes.
CREATE TABLE email_recovery_requests (
  operation_hash text PRIMARY KEY CHECK(operation_hash ~ '^[0-9a-f]{64}$'),
  binding_hash text NOT NULL CHECK(binding_hash ~ '^[0-9a-f]{64}$'),
  instance_id text NOT NULL,
  data_epoch text NOT NULL,
  user_id text REFERENCES users(id) ON DELETE SET NULL,
  activation_version text,
  email_version text,
  address text,
  token_hash text UNIQUE REFERENCES account_recovery_codes(token_hash) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CHECK ((user_id IS NULL)=(activation_version IS NULL)),
  CHECK ((user_id IS NULL)=(email_version IS NULL)),
  CHECK ((user_id IS NULL)=(address IS NULL))
);
CREATE INDEX email_recovery_requests_expiry ON email_recovery_requests(expires_at);
CREATE INDEX email_recovery_requests_user ON email_recovery_requests(user_id);
CREATE TABLE email_recovery_outbox (
  request_hash text PRIMARY KEY REFERENCES email_recovery_requests(operation_hash) ON DELETE CASCADE,
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
CREATE INDEX email_recovery_outbox_ready ON email_recovery_outbox(next_attempt_at)
  WHERE sent_at IS NULL AND payload_cipher IS NOT NULL;
-- Retain only the opaque no-op receipt when an account is deleted. Reusing
-- its username must never resurrect the original request for a new account.
CREATE FUNCTION retire_deleted_account_email_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE email_recovery_outbox SET payload_cipher=NULL,lease_id=NULL,lease_expires_at=NULL
    WHERE request_hash IN (SELECT operation_hash FROM email_recovery_requests WHERE user_id=OLD.id);
  UPDATE email_recovery_requests SET user_id=NULL,activation_version=NULL,email_version=NULL,address=NULL,token_hash=NULL
    WHERE user_id=OLD.id;
  RETURN OLD;
END;
$$;
CREATE TRIGGER retire_deleted_account_email_recovery BEFORE DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION retire_deleted_account_email_recovery();
CREATE VIEW current_email_recovery_requests AS
SELECT r.operation_hash
FROM email_recovery_requests r
JOIN account_recovery_codes c ON c.token_hash=r.token_hash AND c.user_id=r.user_id
JOIN users u ON u.id=r.user_id
JOIN account_emails e ON e.user_id=u.id
JOIN instance i ON i.singleton
WHERE r.expires_at>clock_timestamp() AND c.expires_at>clock_timestamp()
  AND c.revoked_at IS NULL AND c.consumed_at IS NULL AND NOT u.disabled
  AND r.instance_id=i.instance_id AND r.data_epoch=i.data_epoch
  AND c.email_instance_id=i.instance_id AND c.data_epoch=i.data_epoch
  AND r.activation_version=u.activation_version AND c.activation_version=u.activation_version
  AND r.email_version=u.email_version AND c.email_version=u.email_version AND r.address=e.address;
