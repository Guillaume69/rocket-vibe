-- Workflows (RFC 0004): a trigger starts a durable run of steps, acting
-- through one of the owner's bots.

-- The engine's own session of a bot: never listed, counted or revocable as a
-- key; it goes with the bot's devices.
ALTER TABLE bot_keys ADD COLUMN internal boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX bot_keys_internal ON bot_keys(bot_id) WHERE internal;

CREATE TABLE workflows (
    id text PRIMARY KEY,
    owner_id text NOT NULL REFERENCES users(id),
    bot_id text NOT NULL REFERENCES bots(user_id),
    name text NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 128),
    description text NOT NULL DEFAULT '' CHECK (octet_length(description) <= 512),
    enabled boolean NOT NULL DEFAULT false,
    trigger jsonb NOT NULL,
    steps jsonb NOT NULL CHECK (jsonb_typeof(steps) = 'array'),
    revision text NOT NULL DEFAULT gen_random_uuid()::text,
    -- A command trigger's name, unique among workflows.
    command text UNIQUE,
    webhook_hash text,
    next_fire_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    operation_id text NOT NULL,
    UNIQUE (owner_id, operation_id)
);
CREATE INDEX workflows_owner ON workflows(owner_id);
CREATE INDEX workflows_bot ON workflows(bot_id);
CREATE INDEX workflows_due ON workflows(next_fire_at) WHERE enabled AND next_fire_at IS NOT NULL;
CREATE INDEX workflows_joins ON workflows((trigger->>'room')) WHERE enabled AND trigger->>'kind' = 'member_joined';

CREATE TABLE workflow_runs (
    id text PRIMARY KEY,
    workflow_id text NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    revision text NOT NULL,
    -- The steps as they were when the run began: editing never touches a run.
    definition jsonb NOT NULL,
    context jsonb NOT NULL,
    step integer NOT NULL DEFAULT 0,
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','waiting','done','failed','cancelled')),
    wake_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    lease_id text,
    lease_expires_at timestamptz,
    attempts integer NOT NULL DEFAULT 0,
    error text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX workflow_runs_due ON workflow_runs(wake_at) WHERE state IN ('pending','waiting');
CREATE INDEX workflow_runs_workflow ON workflow_runs(workflow_id, created_at DESC);

-- A form a run posted and waits on. The message carries it to the apps.
CREATE TABLE workflow_forms (
    message_id text PRIMARY KEY REFERENCES messages(id),
    run_id text NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    step integer NOT NULL,
    room_id text NOT NULL REFERENCES rooms(id),
    recipient_id text REFERENCES users(id),
    title text NOT NULL,
    fields jsonb NOT NULL,
    answers jsonb,
    answered_by text REFERENCES users(id),
    answered_at timestamptz,
    expires_at timestamptz NOT NULL,
    operation_id text
);
CREATE INDEX workflow_forms_run ON workflow_forms(run_id);

-- Budgets of a workflow (runs started a minute), webhook calls included.
CREATE TABLE workflow_windows (
    workflow_id text PRIMARY KEY REFERENCES workflows(id) ON DELETE CASCADE,
    attempts integer NOT NULL,
    expires_at timestamptz NOT NULL
);
