-- Rocket.Chat import (docs/protocol/IMPORT.md).

-- A Rocket.Chat password hash (bcrypt of the SHA-256 hex of the password),
-- checked once at the next sign-in, then replaced by the native hash.
ALTER TABLE users ADD COLUMN legacy_password text;

-- Any change of the native hash makes the old one meaningless: recovery,
-- reset and the first sign-in alike.
CREATE FUNCTION users_drop_legacy_password() RETURNS trigger AS $$
BEGIN
    IF NEW.password_hash IS DISTINCT FROM OLD.password_hash THEN
        NEW.legacy_password := NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER users_drop_legacy_password BEFORE UPDATE OF password_hash ON users
    FOR EACH ROW EXECUTE FUNCTION users_drop_legacy_password();

-- Source object → native object, so a rerun skips what is already there.
CREATE TABLE import_ids (
    kind text NOT NULL,
    source_id text NOT NULL,
    native_id text NOT NULL,
    PRIMARY KEY (kind, source_id)
);

-- One import per instance: its source and how far it went.
CREATE TABLE import_state (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    source text NOT NULL,
    phase text NOT NULL,
    cursor jsonb,
    started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    finished_at timestamptz
);

-- What the source held and the instance did not take, with the reason.
CREATE TABLE import_omissions (
    kind text NOT NULL,
    source_id text NOT NULL,
    reason text NOT NULL,
    detail text NOT NULL DEFAULT '',
    PRIMARY KEY (kind, source_id, reason)
);

CREATE TABLE import_reports (
    id bigserial PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    report jsonb NOT NULL
);
