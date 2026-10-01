\set ON_ERROR_STOP on
-- Fixture only: age this account's connected family so settings must acquire
-- an explicit proof. Preserve expiry and real session rotation.
CREATE FUNCTION pilot_security_device_age() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id=(SELECT id FROM users WHERE username='gtk-security')
     AND EXISTS(SELECT 1 FROM user_factors WHERE user_id=NEW.user_id) THEN
    NEW.created_at:=clock_timestamp()-interval '20 minutes';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pilot_security_device_age BEFORE INSERT ON session_devices
  FOR EACH ROW EXECUTE FUNCTION pilot_security_device_age();
-- Count consumption without keeping the hash or any recoverable code.
CREATE TABLE pilot_security_consumptions (user_id text NOT NULL);
CREATE FUNCTION pilot_security_consumed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL THEN
    INSERT INTO pilot_security_consumptions VALUES(NEW.user_id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pilot_security_consumed AFTER UPDATE OF consumed_at ON factor_backup_codes
  FOR EACH ROW EXECUTE FUNCTION pilot_security_consumed();
