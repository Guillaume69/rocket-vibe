\set ON_ERROR_STOP on
DO $$ DECLARE account text;
  fixture text:=coalesce(nullif(current_setting('rocketvibe.pilot_email_settings_user',true),''),'gtk-email');
BEGIN
  IF fixture NOT IN ('gtk-email','swift-email') THEN RAISE EXCEPTION 'Requires disposable email settings fixture'; END IF;
  SELECT id INTO STRICT account FROM users WHERE username=fixture;
  IF (SELECT count(*) FROM session_devices WHERE user_id=account)<>1
     OR (SELECT count(*) FROM sessions WHERE user_id=account)<>1 THEN
    RAISE EXCEPTION 'Expected one original UI family and credential';
  END IF;
  IF EXISTS(SELECT 1 FROM user_email_factors WHERE user_id=account)
     OR EXISTS(SELECT 1 FROM user_factors WHERE user_id=account)
     OR EXISTS(SELECT 1 FROM factor_backup_codes WHERE user_id=account) THEN
    RAISE EXCEPTION 'Last factor removal must clear profiles and backup bag';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM account_emails WHERE user_id=account AND address=fixture||'@example.test') THEN
    RAISE EXCEPTION 'Factor removal must preserve original verified contact';
  END IF;
  IF (SELECT count(*) FROM email_factor_changes WHERE user_id=account)<>2
     OR (SELECT count(*) FROM email_delivery_admissions)<>1
     OR EXISTS(SELECT 1 FROM factor_email_deliveries WHERE user_id=account) THEN
    RAISE EXCEPTION 'Expected original enable/remove receipts and contact delivery only';
  END IF;
  IF (SELECT count(*) FROM reauthentication_challenges WHERE user_id=account AND factor_completed AND authenticated_at IS NOT NULL)<>1
     OR NOT EXISTS(SELECT 1 FROM reauthentication_grants g JOIN reauthentication_challenges c
       ON c.device_id=g.device_id AND c.committed_version=g.proof_version
       WHERE g.user_id=account AND g.authenticated_at=c.authenticated_at
         AND g.expires_at=c.authenticated_at+interval '15 minutes') THEN
    RAISE EXCEPTION 'Full proof must retain its original receipt and authentication age';
  END IF;
  RAISE NOTICE 'Email settings: one original UI family, two original profile receipts, verified contact retained';
END $$;
