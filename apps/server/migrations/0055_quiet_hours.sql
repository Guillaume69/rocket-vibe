-- Do not disturb on a schedule (a daily window in the account's IANA time zone)
-- or until an instant. Either silences push and call rings; the app still shows
-- everything, and a reply sent from a notification already delivered still works.
ALTER TABLE users ADD COLUMN quiet_start smallint CHECK (quiet_start BETWEEN 0 AND 1439);
ALTER TABLE users ADD COLUMN quiet_end smallint CHECK (quiet_end BETWEEN 0 AND 1439);
ALTER TABLE users ADD COLUMN quiet_zone text CHECK (octet_length(quiet_zone) BETWEEN 1 AND 64);
ALTER TABLE users ADD COLUMN muted_until timestamptz;
ALTER TABLE users ADD CONSTRAINT users_quiet_hours CHECK (
    (quiet_start IS NULL AND quiet_end IS NULL AND quiet_zone IS NULL)
    OR (quiet_start IS NOT NULL AND quiet_end IS NOT NULL AND quiet_zone IS NOT NULL AND quiet_start <> quiet_end)
);

CREATE OR REPLACE FUNCTION rotate_profile_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.username,NEW.display_name,NEW.bio,NEW.status_text,NEW.chosen_status,NEW.avatar_file_id)
       IS DISTINCT FROM (OLD.username,OLD.display_name,OLD.bio,OLD.status_text,OLD.chosen_status,OLD.avatar_file_id) THEN
        NEW.profile_version := gen_random_uuid()::text;
    END IF;
    IF (NEW.preferred_language,NEW.clock_24h,NEW.push_enabled,NEW.push_mentions_only,NEW.desktop_notifications,
        NEW.quiet_start,NEW.quiet_end,NEW.quiet_zone,NEW.muted_until)
       IS DISTINCT FROM (OLD.preferred_language,OLD.clock_24h,OLD.push_enabled,OLD.push_mentions_only,OLD.desktop_notifications,
        OLD.quiet_start,OLD.quiet_end,OLD.quiet_zone,OLD.muted_until) THEN
        NEW.preferences_version := gen_random_uuid()::text;
    END IF;
    RETURN NEW;
END;
$$;

-- Whether the account is in do not disturb now: muted, or inside its daily
-- window (a window with start > end crosses midnight). `now()` is the
-- transaction's instant, the same for every row it judges.
CREATE FUNCTION account_quiet(quiet_start smallint, quiet_end smallint, quiet_zone text, muted_until timestamptz)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT COALESCE(muted_until > now(), false)
        OR COALESCE((
            SELECT CASE WHEN quiet_start < quiet_end
                        THEN minute >= quiet_start AND minute < quiet_end
                        ELSE minute >= quiet_start OR minute < quiet_end END
            FROM (SELECT (EXTRACT(HOUR FROM now() AT TIME ZONE quiet_zone) * 60
                          + EXTRACT(MINUTE FROM now() AT TIME ZONE quiet_zone))::int AS minute) local
            WHERE quiet_start IS NOT NULL
        ), false)
$$;

-- The recipients a push may still go to: eligible, and not in do not disturb.
-- Capture and delivery read this one; reading a delivered push's content and
-- replying from it keep reading `eligible_push_recipients`.
CREATE VIEW audible_push_recipients AS
SELECT e.*
FROM eligible_push_recipients e
JOIN users u ON u.id = e.user_id
WHERE NOT account_quiet(u.quiet_start, u.quiet_end, u.quiet_zone, u.muted_until);
