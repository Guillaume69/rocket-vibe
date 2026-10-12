-- A full UpdateRoom command also names kind/read_only when only its text or
-- voice flag changes. Keep the encryption policy binding in that case, while
-- rotating every real policy change (including a change restored later).
CREATE OR REPLACE FUNCTION rotate_room_authority_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.kind IS DISTINCT FROM NEW.kind OR OLD.read_only IS DISTINCT FROM NEW.read_only THEN
        NEW.authority_version := gen_random_uuid()::text;
    END IF;
    RETURN NEW;
END;
$$;
