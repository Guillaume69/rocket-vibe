\set ON_ERROR_STOP on
CREATE FUNCTION pilot_email_otp_age() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id IN (SELECT id FROM users WHERE username IN ('gtk-email','swift-email'))
     AND EXISTS(SELECT 1 FROM user_email_factors WHERE user_id=NEW.user_id) THEN
    NEW.created_at:=clock_timestamp()-interval '20 minutes';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pilot_email_otp_age BEFORE INSERT ON session_devices
  FOR EACH ROW EXECUTE FUNCTION pilot_email_otp_age();
