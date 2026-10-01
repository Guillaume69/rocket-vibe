-- Disposable pilot only: the first bearer of each new device expires tomorrow.
-- Its successor retains the server's normal 30-day duration. This exercises
-- renewal in the actual clients without a production-only test endpoint.
CREATE TABLE pilot_seen_session_devices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, renewals INTEGER NOT NULL DEFAULT 0);
CREATE FUNCTION pilot_initial_session_expiry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE first_device TEXT;
BEGIN
    INSERT INTO pilot_seen_session_devices(id,user_id) VALUES(NEW.device_id,NEW.user_id)
        ON CONFLICT DO NOTHING RETURNING id INTO first_device;
    IF first_device IS NOT NULL THEN
        NEW.expires_at := now()+interval '1 day';
    ELSE
        UPDATE pilot_seen_session_devices SET renewals=renewals+1 WHERE id=NEW.device_id;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER pilot_initial_session_expiry BEFORE INSERT ON sessions
    FOR EACH ROW EXECUTE FUNCTION pilot_initial_session_expiry();
