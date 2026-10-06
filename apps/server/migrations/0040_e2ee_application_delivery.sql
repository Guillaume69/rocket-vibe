-- Protect both immutable scope keys with KEY SHARE while allowing the native
-- position counter's NO KEY UPDATE. Crypto publishers share that sequencer.
ALTER TABLE instance ADD CONSTRAINT instance_identity_unique UNIQUE(instance_id);

-- Admission continuity excludes certificate renewal, but includes the exact
-- member grant, root, incarnation, leaf and original one-use KeyPackage.
CREATE TABLE e2ee_group_recipients (
    room_id TEXT NOT NULL,
    revision BIGINT NOT NULL,
    device_id TEXT NOT NULL,
    witness JSONB NOT NULL,
    PRIMARY KEY(room_id,revision,device_id),
    FOREIGN KEY(room_id,revision) REFERENCES e2ee_group_events(room_id,revision)
);
CREATE INDEX e2ee_group_recipient_tenure ON e2ee_group_recipients(room_id,device_id,witness,revision);
INSERT INTO e2ee_group_recipients(room_id,revision,device_id,witness)
SELECT e.room_id,e.revision,p->>'device',jsonb_build_array(
    d->'plan'->'scope',p->'user',p->'device',p->'incarnation',p->'root',p->'leaf',p->'key_package',
    m->'access_version',m->'activation_version')
FROM e2ee_group_events e,
LATERAL (SELECT convert_from(e.transition,'UTF8')::jsonb AS d) decoded,
LATERAL jsonb_array_elements(d->'plan'->'participants') p,
LATERAL jsonb_array_elements(d->'plan'->'members') m
WHERE m->>'user'=p->>'user';

CREATE TABLE e2ee_application_messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    group_revision BIGINT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    device_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    proof BYTEA NOT NULL CHECK(octet_length(proof)>0 AND octet_length(proof)<=16384),
    ciphertext BYTEA NOT NULL CHECK(octet_length(ciphertext)>0 AND octet_length(ciphertext)<=131072),
    receipt JSONB NOT NULL,
    thread_root TEXT REFERENCES e2ee_application_messages(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(user_id,operation_id),
    FOREIGN KEY(room_id,group_revision) REFERENCES e2ee_group_events(room_id,revision)
);
CREATE TABLE e2ee_delivery (
    position BIGINT PRIMARY KEY CHECK(position>0),
    room_id TEXT NOT NULL,
    group_revision BIGINT NOT NULL,
    message_id TEXT UNIQUE REFERENCES e2ee_application_messages(id),
    FOREIGN KEY(room_id,group_revision) REFERENCES e2ee_group_events(room_id,revision)
);
CREATE INDEX e2ee_delivery_room ON e2ee_delivery(room_id,position);
CREATE UNIQUE INDEX e2ee_delivery_group ON e2ee_delivery(room_id,group_revision) WHERE message_id IS NULL;

-- No application ciphertexts existed before this migration. Preserve each
-- existing group's revision order before the first new message can be stored.
DO $$
DECLARE event RECORD; sequence_position BIGINT;
BEGIN
    FOR event IN SELECT room_id,revision FROM e2ee_group_events ORDER BY room_id,revision LOOP
        UPDATE instance SET position=position+1 WHERE singleton RETURNING position INTO sequence_position;
        INSERT INTO e2ee_delivery(position,room_id,group_revision) VALUES(sequence_position,event.room_id,event.revision);
    END LOOP;
END;
$$;

CREATE TABLE e2ee_message_budgets (
    user_id TEXT NOT NULL REFERENCES users(id),
    device_id TEXT NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    used INTEGER NOT NULL CHECK(used>=0),
    PRIMARY KEY(user_id,device_id)
);
