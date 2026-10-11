-- Thread list, following and "also send to the room" (docs/protocol/THREADS.md).
-- A reply its author also posted to the room's timeline. It stays a reply.
ALTER TABLE messages ADD COLUMN also_in_room BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE messages ADD CONSTRAINT messages_also_in_room_reply
    CHECK(NOT also_in_room OR reply_to IS NOT NULL);

-- Who follows a thread. The root's author and every replier get a row when they
-- first take part; an explicit unfollow keeps the row with present=false, so a
-- later reply by someone else does not bring it back. Revisions come from the
-- instance sequence, like message_stars.
CREATE TABLE thread_follows (
    root_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    present BOOLEAN NOT NULL,
    revision BIGINT NOT NULL CHECK(revision>0),
    PRIMARY KEY(root_id,user_id),
    FOREIGN KEY(root_id,room_id) REFERENCES messages(id,room_id) ON DELETE CASCADE,
    FOREIGN KEY(room_id,user_id) REFERENCES members(room_id,user_id) ON DELETE CASCADE
);
CREATE INDEX thread_follows_user ON thread_follows(user_id,room_id) WHERE present;

-- The list groups a room's live replies by root.
CREATE INDEX messages_room_replies ON messages(room_id,reply_to,position)
    WHERE reply_to IS NOT NULL AND NOT deleted;
