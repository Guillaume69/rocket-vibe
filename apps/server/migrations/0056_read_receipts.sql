-- Read receipts are shared both ways: an account that turns them off hides how
-- far it read and stops seeing how far the others did. On by default.
ALTER TABLE users ADD COLUMN share_reads boolean NOT NULL DEFAULT true;

CREATE OR REPLACE FUNCTION rotate_profile_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.username,NEW.display_name,NEW.bio,NEW.status_text,NEW.chosen_status,NEW.avatar_file_id)
       IS DISTINCT FROM (OLD.username,OLD.display_name,OLD.bio,OLD.status_text,OLD.chosen_status,OLD.avatar_file_id) THEN
        NEW.profile_version := gen_random_uuid()::text;
    END IF;
    IF (NEW.preferred_language,NEW.clock_24h,NEW.push_enabled,NEW.push_mentions_only,NEW.desktop_notifications,
        NEW.quiet_start,NEW.quiet_end,NEW.quiet_zone,NEW.muted_until,NEW.share_reads)
       IS DISTINCT FROM (OLD.preferred_language,OLD.clock_24h,OLD.push_enabled,OLD.push_mentions_only,OLD.desktop_notifications,
        OLD.quiet_start,OLD.quiet_end,OLD.quiet_zone,OLD.muted_until,OLD.share_reads) THEN
        NEW.preferences_version := gen_random_uuid()::text;
    END IF;
    RETURN NEW;
END;
$$;
