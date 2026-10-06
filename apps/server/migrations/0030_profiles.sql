ALTER TABLE users ADD COLUMN bio text NOT NULL DEFAULT '' CHECK (octet_length(bio)<=4096);
ALTER TABLE users ADD COLUMN status_text text NOT NULL DEFAULT '' CHECK (octet_length(status_text)<=512);
ALTER TABLE users ADD COLUMN chosen_status text NOT NULL DEFAULT 'online' CHECK (chosen_status IN ('online','away','busy','offline'));
ALTER TABLE users ADD COLUMN profile_version text NOT NULL DEFAULT gen_random_uuid()::text;
ALTER TABLE users ADD COLUMN avatar_file_id text;
CREATE INDEX users_avatar ON users(avatar_file_id) WHERE avatar_file_id IS NOT NULL;
ALTER TABLE users ADD COLUMN preferences_version text NOT NULL DEFAULT gen_random_uuid()::text;
ALTER TABLE users ADD COLUMN preferred_language text NOT NULL DEFAULT 'auto' CHECK (preferred_language IN ('auto','fr','en'));
ALTER TABLE users ADD COLUMN clock_24h boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN push_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN push_mentions_only boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN desktop_notifications text NOT NULL DEFAULT 'default' CHECK (desktop_notifications IN ('default','all','mention','nothing'));

CREATE FUNCTION rotate_profile_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.username,NEW.display_name,NEW.bio,NEW.status_text,NEW.chosen_status,NEW.avatar_file_id)
       IS DISTINCT FROM (OLD.username,OLD.display_name,OLD.bio,OLD.status_text,OLD.chosen_status,OLD.avatar_file_id) THEN
        NEW.profile_version := gen_random_uuid()::text;
    END IF;
    IF (NEW.preferred_language,NEW.clock_24h,NEW.push_enabled,NEW.push_mentions_only,NEW.desktop_notifications)
       IS DISTINCT FROM (OLD.preferred_language,OLD.clock_24h,OLD.push_enabled,OLD.push_mentions_only,OLD.desktop_notifications) THEN
        NEW.preferences_version := gen_random_uuid()::text;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER user_profile_changed BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION rotate_profile_version();

-- Receipts contain no profile text, email or image bytes.
CREATE TABLE profile_commands (
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operation_id text NOT NULL,
    command_hash text NOT NULL,
    applied_revision text NOT NULL,
    PRIMARY KEY(user_id,operation_id)
);
CREATE TABLE profile_windows (
    user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    attempts integer NOT NULL,
    expires_at timestamptz NOT NULL
);
