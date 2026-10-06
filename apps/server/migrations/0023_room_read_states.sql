-- Personal state belongs to a membership lifetime. Rejoining starts afresh.
CREATE TABLE room_read_states (
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    membership_version TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    root_position BIGINT NOT NULL DEFAULT 0 CHECK (root_position>=0),
    reply_position BIGINT NOT NULL DEFAULT 0 CHECK (reply_position>=0),
    favorite BOOLEAN NOT NULL DEFAULT false,
    favorite_revision BIGINT NOT NULL DEFAULT 0 CHECK (favorite_revision>=0),
    revision BIGINT NOT NULL DEFAULT 0 CHECK (revision>=0),
    PRIMARY KEY(room_id,user_id),
    FOREIGN KEY(room_id,user_id) REFERENCES members(room_id,user_id) ON DELETE CASCADE
);
CREATE INDEX room_read_states_user ON room_read_states(user_id,room_id);
CREATE INDEX messages_unread ON messages(room_id,position) INCLUDE(author_id) WHERE NOT deleted;
INSERT INTO room_read_states(room_id,user_id,root_position,revision,favorite_revision)
    SELECT m.room_id,m.user_id,COALESCE((SELECT max(position) FROM messages WHERE room_id=m.room_id),0),GREATEST(r.revision,1),GREATEST(r.revision,1)
    FROM members m JOIN rooms r ON r.id=m.room_id;

CREATE FUNCTION seed_room_read_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO room_read_states(room_id,user_id,root_position)
        VALUES(NEW.room_id,NEW.user_id,COALESCE((SELECT max(position) FROM messages WHERE room_id=NEW.room_id),0));
    RETURN NULL;
END;
$$;
CREATE TRIGGER room_read_state_joined AFTER INSERT ON members
    FOR EACH ROW EXECUTE FUNCTION seed_room_read_state();

CREATE TABLE room_read_windows (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    attempts INTEGER NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);
