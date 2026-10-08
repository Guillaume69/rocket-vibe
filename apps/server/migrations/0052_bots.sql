-- Bot accounts (RFC 0003). A bot is a users row (users.bot) owned by a person;
-- each of its API keys is a session of its own device, so authentication,
-- read proofs, cursors and tickets apply unchanged.

-- Every account may create bots when true; administrators always may.
ALTER TABLE instance ADD COLUMN user_bots boolean NOT NULL DEFAULT false;

-- Set once, at creation, together with the bots row. Its password hash is
-- unusable and sign-in never considers it.
ALTER TABLE users ADD COLUMN bot boolean NOT NULL DEFAULT false;

CREATE TABLE bots (
    user_id text PRIMARY KEY REFERENCES users(id),
    owner_id text NOT NULL REFERENCES users(id),
    description text NOT NULL DEFAULT '' CHECK (octet_length(description) <= 512),
    scopes text[] NOT NULL DEFAULT '{}' CHECK (scopes <@ ARRAY[
        'rooms:read','messages:write','files:write','reactions:write',
        'rooms:join','users:read','dm:write']::text[]),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    -- Its creation: a replay of the same intent returns this bot.
    operation_id text NOT NULL,
    UNIQUE (owner_id, operation_id),
    CHECK (owner_id <> user_id)
);
CREATE INDEX bots_owner ON bots(owner_id);

-- Revoking a key deletes its device: the cascade takes the session and the key.
CREATE TABLE bot_keys (
    id text PRIMARY KEY,
    bot_id text NOT NULL REFERENCES bots(user_id),
    device_id text NOT NULL UNIQUE REFERENCES session_devices(id) ON DELETE CASCADE,
    label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 64),
    hint text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    -- NULL: never expires (its session carries a far deadline instead).
    expires_at timestamptz,
    -- Set by the gate, at most once a minute per key.
    last_used_at timestamptz
);
CREATE INDEX bot_keys_bot ON bot_keys(bot_id);

-- A bot is never an administrator, nor owns bots itself.
CREATE FUNCTION refuse_bot_privilege() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.bot AND NEW.admin THEN
        RAISE EXCEPTION 'bot administrator' USING ERRCODE='check_violation';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER user_bot_privilege BEFORE INSERT OR UPDATE OF admin, bot ON users
    FOR EACH ROW EXECUTE FUNCTION refuse_bot_privilege();

CREATE FUNCTION refuse_bot_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS(SELECT 1 FROM users WHERE id=NEW.owner_id AND bot)
       OR NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND bot) THEN
        RAISE EXCEPTION 'bot owner' USING ERRCODE='check_violation';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER bot_owner_person BEFORE INSERT OR UPDATE OF owner_id, user_id ON bots
    FOR EACH ROW EXECUTE FUNCTION refuse_bot_owner();

-- An owner deactivated (or deleted, which deactivates first) takes its bots
-- down in the same transaction. Re-enabling the owner leaves them disabled.
CREATE FUNCTION disable_owned_bots() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.disabled AND NOT OLD.disabled THEN
        UPDATE users SET disabled=true
            WHERE NOT disabled AND id IN (SELECT user_id FROM bots WHERE owner_id=NEW.id);
    END IF;
    RETURN NULL;
END;
$$;
CREATE TRIGGER user_disables_bots AFTER UPDATE OF disabled ON users
    FOR EACH ROW EXECUTE FUNCTION disable_owned_bots();

-- A bot authenticates with its keys only: no sign-in, invitation or recovery
-- session may ever be created for it.
CREATE FUNCTION refuse_bot_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND bot)
       AND NOT EXISTS(SELECT 1 FROM bot_keys WHERE device_id=NEW.device_id) THEN
        RAISE EXCEPTION 'bot session' USING ERRCODE='check_violation';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER session_bot_key BEFORE INSERT ON sessions
    FOR EACH ROW EXECUTE FUNCTION refuse_bot_session();

-- Per-bot budgets (sends, new direct conversations), a 60-second window each.
CREATE TABLE bot_windows (
    user_id text NOT NULL REFERENCES users(id),
    kind text NOT NULL,
    attempts integer NOT NULL,
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (user_id, kind)
);
