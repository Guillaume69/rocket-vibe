ALTER TABLE messages ADD COLUMN reply_to TEXT;
ALTER TABLE messages ADD CONSTRAINT messages_room_identity UNIQUE(id,room_id);
ALTER TABLE messages ADD CONSTRAINT messages_thread_room
    FOREIGN KEY(reply_to,room_id) REFERENCES messages(id,room_id);
ALTER TABLE messages ADD CONSTRAINT messages_thread_not_self CHECK(reply_to<>id);
ALTER TABLE messages ADD CONSTRAINT messages_system_not_reply CHECK(system IS NULL OR reply_to IS NULL);
CREATE INDEX messages_thread ON messages(reply_to,position DESC) WHERE reply_to IS NOT NULL;

CREATE TABLE thread_read_states (
    root_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    position BIGINT NOT NULL DEFAULT 0 CHECK(position>=0),
    revision BIGINT NOT NULL DEFAULT 0 CHECK(revision>=0),
    PRIMARY KEY(root_id,user_id),
    FOREIGN KEY(root_id,room_id) REFERENCES messages(id,room_id) ON DELETE CASCADE,
    FOREIGN KEY(room_id,user_id) REFERENCES members(room_id,user_id) ON DELETE CASCADE
);

-- A new membership has seen the existing room, including its replies.
CREATE OR REPLACE FUNCTION seed_room_read_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE last_position BIGINT;
BEGIN
    SELECT COALESCE(max(position),0) INTO last_position FROM messages WHERE room_id=NEW.room_id;
    INSERT INTO room_read_states(room_id,user_id,root_position,reply_position)
        VALUES(NEW.room_id,NEW.user_id,last_position,last_position);
    RETURN NULL;
END;
$$;
