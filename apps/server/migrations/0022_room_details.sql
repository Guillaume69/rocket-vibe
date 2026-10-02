ALTER TABLE rooms ADD COLUMN topic TEXT NOT NULL DEFAULT '' CHECK (octet_length(topic)<=1024);
ALTER TABLE rooms ADD COLUMN description TEXT NOT NULL DEFAULT '' CHECK (octet_length(description)<=4096);
ALTER TABLE rooms ADD COLUMN announcement TEXT NOT NULL DEFAULT '' CHECK (octet_length(announcement)<=4096);
ALTER TABLE rooms ADD COLUMN details_version TEXT NOT NULL DEFAULT gen_random_uuid()::text;

CREATE FUNCTION rotate_room_details_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.details_version := gen_random_uuid()::text;
    RETURN NEW;
END;
$$;
CREATE TRIGGER room_details_changed BEFORE UPDATE OF name,kind,read_only,topic,description,announcement ON rooms
    FOR EACH ROW EXECUTE FUNCTION rotate_room_details_version();

-- Production membership writers lock the room before its membership rows.
-- This nonce detects remove/rejoin and role ABA while paging the roster.
CREATE FUNCTION rotate_room_roster_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='DELETE' THEN
        UPDATE rooms SET details_version=gen_random_uuid()::text WHERE id=OLD.room_id;
    ELSE
        UPDATE rooms SET details_version=gen_random_uuid()::text WHERE id=NEW.room_id;
    END IF;
    RETURN NULL;
END;
$$;
CREATE TRIGGER room_roster_changed AFTER INSERT OR UPDATE OR DELETE ON members
    FOR EACH ROW EXECUTE FUNCTION rotate_room_roster_version();

-- Receipts retain no settings text or roster, only command fingerprints.
CREATE TABLE room_commands (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    command_hash TEXT NOT NULL,
    applied_revision TEXT NOT NULL,
    PRIMARY KEY (user_id,operation_id)
);
CREATE TABLE room_command_windows (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    attempts INTEGER NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);
