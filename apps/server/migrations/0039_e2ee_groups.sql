-- Permanent per-incarnation fence: crypto mutations take UPDATE, group
-- validation/delivery takes SHARE before reading public heads. No room locks
-- in these triggers, and no group-recipient FK back to users/device heads.
CREATE TABLE e2ee_device_fences (
    device_id TEXT NOT NULL,
    incarnation TEXT NOT NULL,
    retired BOOLEAN NOT NULL DEFAULT false,
    PRIMARY KEY(device_id,incarnation)
);
INSERT INTO e2ee_device_fences(device_id,incarnation)
SELECT device_id,incarnation FROM e2ee_devices;
CREATE FUNCTION fence_e2ee_device() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP<>'INSERT' THEN
        IF TG_OP='DELETE' THEN
            UPDATE e2ee_device_fences SET retired=true WHERE device_id=OLD.device_id AND incarnation=OLD.incarnation;
        ELSE
            UPDATE e2ee_device_fences SET retired=retired OR OLD.incarnation<>NEW.incarnation
              WHERE device_id=OLD.device_id AND incarnation=OLD.incarnation;
        END IF;
    END IF;
    IF TG_OP<>'DELETE' THEN
        INSERT INTO e2ee_device_fences(device_id,incarnation) VALUES(NEW.device_id,NEW.incarnation)
          ON CONFLICT(device_id,incarnation) DO NOTHING;
        RETURN NEW;
    END IF;
    RETURN OLD;
END;
$$;
CREATE TRIGGER e2ee_device_fence BEFORE INSERT OR UPDATE OR DELETE ON e2ee_devices
FOR EACH ROW EXECUTE FUNCTION fence_e2ee_device();

CREATE TABLE e2ee_groups (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id),
    data_epoch TEXT NOT NULL,
    incarnation TEXT NOT NULL,
    revision BIGINT NOT NULL CHECK(revision>0),
    epoch BIGINT NOT NULL CHECK(epoch>=0),
    fingerprint TEXT NOT NULL,
    transition BYTEA NOT NULL CHECK(octet_length(transition)<=262144),
    tree BYTEA NOT NULL CHECK(octet_length(tree)<=1048576),
    receipt JSONB NOT NULL
);
CREATE TABLE e2ee_group_events (
    room_id TEXT NOT NULL REFERENCES e2ee_groups(room_id),
    revision BIGINT NOT NULL,
    transition BYTEA NOT NULL CHECK(octet_length(transition)<=262144),
    commit BYTEA CHECK(octet_length(commit)<=1048576),
    receipt JSONB NOT NULL,
    PRIMARY KEY(room_id,revision)
);
CREATE TABLE e2ee_group_welcomes (
    room_id TEXT NOT NULL,
    revision BIGINT NOT NULL,
    device_id TEXT NOT NULL,
    incarnation TEXT NOT NULL,
    access_version TEXT NOT NULL,
    key_package_ref TEXT NOT NULL,
    payload BYTEA NOT NULL CHECK(octet_length(payload)<=1048576),
    PRIMARY KEY(room_id,revision,device_id),
    FOREIGN KEY(room_id,revision) REFERENCES e2ee_group_events(room_id,revision)
);
CREATE TABLE e2ee_group_operations (
    user_id TEXT NOT NULL REFERENCES users(id),
    device_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    result JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(user_id,device_id,operation_id)
);
CREATE INDEX e2ee_group_operations_quota ON e2ee_group_operations(user_id,device_id,created_at);
