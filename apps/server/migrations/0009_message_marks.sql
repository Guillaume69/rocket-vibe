ALTER TABLE messages ADD COLUMN pinned BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX messages_pins ON messages(room_id,position DESC) WHERE pinned AND NOT deleted;
CREATE TABLE message_stars (
    message_id TEXT NOT NULL REFERENCES messages(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    present BOOLEAN NOT NULL,
    revision BIGINT NOT NULL,
    PRIMARY KEY (message_id,user_id)
);
CREATE INDEX message_stars_owner ON message_stars(user_id,message_id) WHERE present;
