-- History shares between devices of one account (E2EE_HISTORY.md). Signed,
-- opaque bytes only: no period secret, recipient key or document.
CREATE TABLE e2ee_history_requests (
    fingerprint TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    -- One pending request per device; a new one replaces it and its share.
    device_id TEXT NOT NULL UNIQUE REFERENCES session_devices(id) ON DELETE CASCADE,
    request BYTEA NOT NULL CHECK(octet_length(request)<=4096),
    expires_at TIMESTAMPTZ NOT NULL,
    -- The request's own expiry, extended for 7 days once a share is committed.
    retained_until TIMESTAMPTZ NOT NULL
);
CREATE INDEX e2ee_history_requests_user ON e2ee_history_requests(user_id);
CREATE INDEX e2ee_history_requests_retention ON e2ee_history_requests(retained_until);
-- Survives replaced and expired requests, for the daily quota.
CREATE TABLE e2ee_history_request_log (
    user_id TEXT NOT NULL REFERENCES users(id),
    device_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(device_id,fingerprint)
);
CREATE INDEX e2ee_history_request_log_quota ON e2ee_history_request_log(user_id,device_id,created_at);
-- Claimed by the first device that uploads a page; committed once signed.
CREATE TABLE e2ee_history_shares (
    request TEXT PRIMARY KEY REFERENCES e2ee_history_requests(fingerprint) ON DELETE CASCADE,
    sharer_device_id TEXT NOT NULL,
    share BYTEA CHECK(octet_length(share)<=1048576),
    records BIGINT NOT NULL DEFAULT 0 CHECK(records>=0),
    bytes BIGINT NOT NULL DEFAULT 0 CHECK(bytes>=0)
);
CREATE TABLE e2ee_history_records (
    request TEXT NOT NULL REFERENCES e2ee_history_shares(request) ON DELETE CASCADE,
    period INTEGER NOT NULL CHECK(period>=0 AND period<1024),
    rank BIGINT NOT NULL CHECK(rank>0),
    room_id TEXT NOT NULL,
    position BIGINT NOT NULL CHECK(position>0),
    digest TEXT NOT NULL,
    record BYTEA NOT NULL CHECK(octet_length(record)>0 AND octet_length(record)<=393216),
    PRIMARY KEY(request,period,rank)
);
