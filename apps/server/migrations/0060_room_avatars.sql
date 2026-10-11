ALTER TABLE rooms ADD COLUMN avatar_object_id TEXT;
CREATE TRIGGER room_avatar_changed BEFORE UPDATE OF avatar_object_id ON rooms
    FOR EACH ROW EXECUTE FUNCTION rotate_room_details_version();
