\set ON_ERROR_STOP on
DO $$ DECLARE account text;
BEGIN
  SELECT id INTO STRICT account FROM users WHERE username='gtk-email';
  IF (SELECT count(*) FROM session_devices WHERE user_id=account)<>1
     OR (SELECT count(*) FROM sessions WHERE user_id=account)<>1 THEN
    RAISE EXCEPTION 'OTP must retain exactly one UI family and credential after seed logout';
  END IF;
  IF (SELECT count(*) FROM factor_email_deliveries WHERE user_id=account)<>2
     OR EXISTS(SELECT 1 FROM factor_email_deliveries WHERE user_id=account AND (consumed_at IS NULL OR payload_cipher IS NOT NULL))
     OR EXISTS(SELECT 1 FROM factor_email_outbox) THEN
    RAISE EXCEPTION 'Expected two consumed OTP deliveries and no retained code payload/outbox';
  END IF;
  IF (SELECT count(*) FROM reauthentication_challenges WHERE user_id=account AND factor_completed AND authenticated_at IS NOT NULL)<>1
     OR (SELECT count(*) FROM email_delivery_admissions)<>3 THEN
    RAISE EXCEPTION 'Expected original full proof and exactly one contact plus two OTP admissions';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM reauthentication_grants g JOIN reauthentication_challenges c
      ON c.device_id=g.device_id AND c.committed_version=g.proof_version
      WHERE g.user_id=account AND g.authenticated_at=c.authenticated_at
        AND g.expires_at=c.authenticated_at+interval '15 minutes') THEN
    RAISE EXCEPTION 'Recovered email proof must preserve its original age';
  END IF;
  IF (SELECT count(*) FROM factor_backup_codes WHERE user_id=account AND consumed_at IS NULL)<>10 THEN
    RAISE EXCEPTION 'Email OTP must not consume or replace the common backup bag';
  END IF;
  RAISE NOTICE 'GTK OTP: two original consumed deliveries, one UI family, one proof and original backup bag';
END $$;
