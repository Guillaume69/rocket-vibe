\set ON_ERROR_STOP on
DO $$
DECLARE remaining bigint; devices bigint; factor_user text := current_setting('rocketvibe.pilot_factor_user');
BEGIN
  IF factor_user NOT IN ('gtk-factor', 'swift-factor') THEN RAISE EXCEPTION 'Unexpected disposable factor account'; END IF;
  SELECT COUNT(*) INTO remaining FROM factor_backup_codes WHERE user_id=(SELECT id FROM users WHERE username=factor_user) AND consumed_at IS NULL;
  IF remaining<>9 THEN RAISE EXCEPTION 'Factor pilot expected exactly one backup code consumed'; END IF;
  SELECT COUNT(*) INTO devices FROM session_devices WHERE user_id=(SELECT id FROM users WHERE username=factor_user);
  IF devices<>1 THEN RAISE EXCEPTION 'Factor pilot expected one surviving session family'; END IF;
  RAISE NOTICE 'Native factor pilot passed for %', factor_user;
END $$;
\echo 'Native factors: incorrect code and lost ACK recovery preserved one session and consumed one backup'
