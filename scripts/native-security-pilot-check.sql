\set ON_ERROR_STOP on
DO $$
DECLARE account text := (SELECT id FROM users WHERE username='gtk-security');
BEGIN
  IF (SELECT count(*) FROM session_devices WHERE user_id=account)<>1 THEN
    RAISE EXCEPTION 'Security settings created another session family';
  END IF;
  IF (SELECT count(*) FROM pilot_security_consumptions WHERE user_id=account)<>2 THEN
    RAISE EXCEPTION 'Expected one sign-in and one identity-proof backup consumption';
  END IF;
  IF (SELECT count(*) FROM factor_backup_regenerations WHERE user_id=account)<>1 THEN
    RAISE EXCEPTION 'Expected exactly one committed backup regeneration';
  END IF;
  IF (SELECT count(*) FROM reauthentication_challenges WHERE user_id=account AND authenticated_at IS NOT NULL AND factor_completed)<>1 THEN
    RAISE EXCEPTION 'Expected exactly one committed full identity proof';
  END IF;
  IF EXISTS(SELECT 1 FROM user_factors WHERE user_id=account) THEN
    RAISE EXCEPTION 'Expected factor disabled after resumed acknowledgement';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM reauthentication_grants g JOIN reauthentication_challenges c
      ON c.device_id=g.device_id AND c.committed_version=g.proof_version
      WHERE g.user_id=account AND g.authenticated_at=c.authenticated_at
        AND g.expires_at=c.authenticated_at+interval '15 minutes') THEN
    RAISE EXCEPTION 'Settings replay or factor mutation changed the original proof age';
  END IF;
  RAISE NOTICE 'Native security: one family, one proof, two consumed codes, one regeneration and committed disable';
END $$;
