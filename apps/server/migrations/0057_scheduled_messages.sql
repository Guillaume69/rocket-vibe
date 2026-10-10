-- Messages the server sends for their author at a chosen time. The operation
-- id becomes the sent message's, so a worker that dies between the send and
-- the row's removal never sends twice. Failed rows stay for their author to
-- read and remove.
CREATE TABLE scheduled_messages (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    operation_id text NOT NULL,
    text text NOT NULL CHECK (octet_length(text) BETWEEN 1 AND 32768),
    reply_to text,
    send_at timestamptz NOT NULL,
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','failed')),
    error text,
    lease_expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, operation_id)
);
CREATE INDEX scheduled_messages_due ON scheduled_messages(send_at) WHERE state = 'pending';
CREATE INDEX scheduled_messages_user ON scheduled_messages(user_id, send_at);
