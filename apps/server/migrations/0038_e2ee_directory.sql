-- Only public identity/device proofs and opaque public MLS KeyPackages.
CREATE TABLE e2ee_identities (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    root BYTEA NOT NULL CHECK(octet_length(root)<=4096),
    fingerprint TEXT NOT NULL,
    revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0)
);
CREATE TABLE e2ee_devices (
    device_id TEXT PRIMARY KEY REFERENCES session_devices(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES e2ee_identities(user_id),
    incarnation TEXT NOT NULL,
    signature_key BYTEA NOT NULL CHECK(octet_length(signature_key)=32),
    certificate BYTEA NOT NULL CHECK(octet_length(certificate)<=4096),
    issued_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    revision BIGINT NOT NULL CHECK(revision>0)
);
CREATE INDEX e2ee_devices_user ON e2ee_devices(user_id);
CREATE TABLE e2ee_revocations (
    position BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES e2ee_identities(user_id),
    device_id TEXT NOT NULL,
    incarnation TEXT NOT NULL,
    signed BYTEA NOT NULL CHECK(octet_length(signed)<=4096),
    UNIQUE(user_id,device_id,incarnation)
);
CREATE INDEX e2ee_revocations_user ON e2ee_revocations(user_id,position);
CREATE TABLE e2ee_key_packages (
    reference TEXT PRIMARY KEY,
    digest TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES e2ee_identities(user_id),
    device_id TEXT NOT NULL,
    incarnation TEXT NOT NULL,
    wire BYTEA CHECK(octet_length(wire)<=16384),
    expires_at BIGINT NOT NULL,
    -- Payload can be discarded, but references remain spent. Never revive on PUT.
    spent BOOLEAN NOT NULL DEFAULT false,
    consumed_operation TEXT,
    consumed_group TEXT
);
CREATE INDEX e2ee_key_packages_device ON e2ee_key_packages(device_id,incarnation) WHERE NOT spent;
CREATE TABLE e2ee_operations (
    user_id TEXT NOT NULL REFERENCES users(id),
    device_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    result JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(user_id,device_id,operation_id)
);
CREATE INDEX e2ee_operations_quota ON e2ee_operations(user_id,device_id,created_at);

CREATE FUNCTION retire_e2ee_device_packages() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE e2ee_key_packages SET spent=true,wire=NULL
      WHERE device_id=OLD.device_id AND incarnation=OLD.incarnation AND NOT spent;
    RETURN OLD;
END;
$$;
CREATE TRIGGER retire_e2ee_device_packages AFTER DELETE ON e2ee_devices
  FOR EACH ROW EXECUTE FUNCTION retire_e2ee_device_packages();
