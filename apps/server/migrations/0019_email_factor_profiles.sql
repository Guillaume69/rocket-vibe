-- E-mail is an independent enrollment, never inferred from a verified contact.
-- Its key-check binds the operator key to this exact contact/profile version.
ALTER TABLE users ADD CONSTRAINT users_email_authority UNIQUE(id,email_version);
CREATE TABLE user_email_factors (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  version text NOT NULL,
  email_version text NOT NULL,
  key_check_cipher bytea NOT NULL,
  enabled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(user_id,email_version) REFERENCES users(id,email_version),
  FOREIGN KEY(user_id) REFERENCES account_emails(user_id)
);

-- Prefer the established TOTP identity when both factors are installed, so
-- adding e-mail does not replace an existing full-login proof's profile id.
CREATE VIEW account_factor_profiles AS
SELECT u.id AS user_id,COALESCE(t.version,e.version) AS version
FROM users u
LEFT JOIN user_factors t ON t.user_id=u.id
LEFT JOIN user_email_factors e ON e.user_id=u.id
WHERE t.user_id IS NOT NULL OR e.user_id IS NOT NULL;

-- The common bag survives removal of either factor while the other remains.
ALTER TABLE factor_backup_codes DROP CONSTRAINT factor_backup_codes_user_id_fkey;
ALTER TABLE factor_backup_codes ADD CONSTRAINT factor_backup_codes_user_id_fkey
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE;
CREATE FUNCTION remove_last_factor_backups() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM account_factor_profiles WHERE user_id=OLD.user_id) THEN
    DELETE FROM factor_backup_codes WHERE user_id=OLD.user_id;
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER totp_last_factor_backups AFTER DELETE ON user_factors
  FOR EACH ROW EXECUTE FUNCTION remove_last_factor_backups();
CREATE TRIGGER email_last_factor_backups AFTER DELETE ON user_email_factors
  FOR EACH ROW EXECUTE FUNCTION remove_last_factor_backups();
