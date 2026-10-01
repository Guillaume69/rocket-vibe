\set ON_ERROR_STOP on
DO $$
DECLARE remaining bigint; devices bigint;
BEGIN
  SELECT COUNT(*) INTO remaining FROM factor_backup_codes WHERE user_id=(SELECT id FROM users WHERE username='gtk-factor') AND consumed_at IS NULL;
  IF remaining<>9 THEN RAISE EXCEPTION 'GTK factor pilot expected exactly one backup code consumed'; END IF;
  SELECT COUNT(*) INTO devices FROM session_devices WHERE user_id=(SELECT id FROM users WHERE username='gtk-factor');
  IF devices<>1 THEN RAISE EXCEPTION 'GTK factor pilot expected one surviving session family'; END IF;
END $$;
\echo 'GTK native factors: incorrect code, lost ACK and process restart preserved one session and consumed one backup'
