-- In-app administration: tombstoned accounts, member reports and the acting
-- account of each audited change. 0049 is reserved by the Rocket.Chat import.
ALTER TABLE users ADD COLUMN deleted boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD CONSTRAINT users_deleted_disabled CHECK (NOT deleted OR disabled);
-- Known only from the audit for older accounts; new rows get their creation time.
ALTER TABLE users ADD COLUMN created_at timestamptz;
UPDATE users u SET created_at=a.created_at
    FROM (SELECT subject,min(created_at) AS created_at FROM operator_audit WHERE action='user.created' GROUP BY subject) a
    WHERE a.subject=u.id;
ALTER TABLE users ALTER COLUMN created_at SET DEFAULT clock_timestamp();

-- Older rooms date from their first message (often their creation activity).
ALTER TABLE rooms ADD COLUMN created_at timestamptz;
UPDATE rooms r SET created_at=(SELECT min(m.created_at) FROM messages m WHERE m.room_id=r.id);
ALTER TABLE rooms ALTER COLUMN created_at SET DEFAULT clock_timestamp();

-- Orders the heirs of a deleted last owner. Existing memberships share the
-- migration instant; their user ID breaks the tie.
ALTER TABLE members ADD COLUMN joined_at timestamptz NOT NULL DEFAULT clock_timestamp();

-- NULL for the operator CLI, the account for an in-app administrator or reporter.
ALTER TABLE operator_audit ADD COLUMN actor_id text;

-- One open report per reporter and target: reporting again replaces it.
-- Closed reports stay for the audit trail; no message text is copied here.
CREATE TABLE message_reports (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    message_id text NOT NULL REFERENCES messages(id),
    reporter_id text NOT NULL REFERENCES users(id),
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 1000),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    closed_at timestamptz,
    closed_by text,
    resolution text CHECK (resolution IN ('dismissed','deleted')),
    CHECK ((closed_at IS NULL)=(resolution IS NULL))
);
CREATE UNIQUE INDEX message_reports_open ON message_reports(message_id,reporter_id) WHERE closed_at IS NULL;
CREATE INDEX message_reports_pending ON message_reports(message_id,id) WHERE closed_at IS NULL;
CREATE TABLE user_reports (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id),
    reporter_id text NOT NULL REFERENCES users(id),
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 1000),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    closed_at timestamptz,
    closed_by text,
    resolution text CHECK (resolution IN ('dismissed','deleted')),
    CHECK ((closed_at IS NULL)=(resolution IS NULL))
);
CREATE UNIQUE INDEX user_reports_open ON user_reports(user_id,reporter_id) WHERE closed_at IS NULL;
CREATE INDEX user_reports_pending ON user_reports(user_id,id) WHERE closed_at IS NULL;

-- Receipts of in-app administration and reports, bound to the acting account.
-- Fingerprints only; kept seven days.
CREATE TABLE moderation_commands (
    actor_id text NOT NULL REFERENCES users(id),
    operation_id text NOT NULL,
    command_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(actor_id,operation_id)
);
CREATE INDEX moderation_commands_expiry ON moderation_commands(created_at);
