-- The server's icon, which the apps draw on their server rail instead of the
-- host's initial. An administrator sets and removes it; the object lives in
-- the private volume like avatars, and the revision moves on every change so
-- the clients' image caches follow (`Discovery.icon_revision`).
ALTER TABLE instance ADD COLUMN icon_object_id text;
ALTER TABLE instance ADD COLUMN icon_revision bigint NOT NULL DEFAULT 0 CHECK (icon_revision >= 0);
