-- Distinguish a fresh grant from removal/rejoining and from a role change.
ALTER TABLE members ADD COLUMN access_version TEXT NOT NULL DEFAULT gen_random_uuid()::text;
CREATE FUNCTION rotate_member_access_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.access_version := gen_random_uuid()::text;
    RETURN NEW;
END;
$$;
CREATE TRIGGER member_access_changed BEFORE UPDATE ON members
    FOR EACH ROW EXECUTE FUNCTION rotate_member_access_version();

-- KEY SHARE delivery leases allow sequence increments (NO KEY UPDATE), while
-- changing the generation must wait for responses authorized in the old one.
ALTER TABLE instance ADD CONSTRAINT instance_epoch_unique UNIQUE (data_epoch);

-- Delivery may coexist with ordinary per-author serialization. Changing a
-- user's activation status changes this key, which conflicts with KEY SHARE.
ALTER TABLE users ADD COLUMN activation_version TEXT NOT NULL DEFAULT gen_random_uuid()::text UNIQUE;
CREATE FUNCTION rotate_user_activation_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.activation_version := gen_random_uuid()::text;
    RETURN NEW;
END;
$$;
CREATE TRIGGER user_activation_changed BEFORE UPDATE OF disabled ON users
    FOR EACH ROW EXECUTE FUNCTION rotate_user_activation_version();

-- Cursor quotas must not wait for an author with an uncommitted mutation.
CREATE TABLE cursor_budgets (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE
);
