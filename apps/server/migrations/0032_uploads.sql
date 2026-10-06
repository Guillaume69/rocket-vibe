-- A reservation and its final object precede the message's atomic confirmation.
CREATE TABLE uploads (
 id text PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id),
 operation_id text NOT NULL,
 fingerprint text NOT NULL,
 room_id text NOT NULL REFERENCES rooms(id),
 membership_version text NOT NULL,
 data_epoch text NOT NULL,
 bytes bigint NOT NULL CHECK (bytes>0 AND bytes<=104857600),
 sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
 media_type text NOT NULL,
 filename text NOT NULL,
 state text NOT NULL CHECK (state IN ('prepared','ready','completed','cancelled','expired')),
 object_id text,
 lease_id text,
 lease_expires_at timestamptz,
 message_id text REFERENCES messages(id),
 complete_fingerprint text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
 UNIQUE(user_id,operation_id),
 CHECK ((state='completed')=(message_id IS NOT NULL))
);
CREATE INDEX uploads_gc ON uploads(expires_at) WHERE state IN ('prepared','ready');
CREATE INDEX uploads_objects ON uploads(object_id) WHERE object_id IS NOT NULL;
CREATE INDEX uploads_admission ON uploads(user_id,created_at);
ALTER TABLE messages ADD COLUMN files jsonb NOT NULL DEFAULT '[]'::jsonb;
