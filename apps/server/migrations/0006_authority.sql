ALTER TABLE users ADD COLUMN create_public_room BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN create_private_room BOOLEAN NOT NULL DEFAULT true;
DROP TRIGGER user_activation_changed ON users;
CREATE TRIGGER user_activation_changed BEFORE UPDATE OF disabled, admin, create_public_room, create_private_room ON users
    FOR EACH ROW EXECUTE FUNCTION rotate_user_activation_version();

ALTER TABLE members DROP CONSTRAINT members_role_check;
ALTER TABLE members ADD CONSTRAINT members_role_check CHECK (role IN ('owner', 'moderator', 'member'));
ALTER TABLE rooms ADD COLUMN read_only BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE rooms ADD COLUMN authority_version TEXT NOT NULL DEFAULT gen_random_uuid()::text UNIQUE;
CREATE FUNCTION rotate_room_authority_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.authority_version := gen_random_uuid()::text;
    RETURN NEW;
END;
$$;
CREATE TRIGGER room_authority_changed BEFORE UPDATE OF read_only, kind ON rooms
    FOR EACH ROW EXECUTE FUNCTION rotate_room_authority_version();
