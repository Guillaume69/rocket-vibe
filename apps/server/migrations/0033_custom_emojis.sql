CREATE TABLE emoji_catalog (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
    revision BIGINT NOT NULL DEFAULT 0 CHECK(revision >= 0)
);
INSERT INTO emoji_catalog(singleton) VALUES(TRUE);
CREATE TABLE custom_emojis (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    aliases JSONB NOT NULL DEFAULT '[]',
    object_id TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    media_type TEXT NOT NULL CHECK(media_type IN ('image/png','image/gif')),
    bytes INTEGER NOT NULL CHECK(bytes > 0 AND bytes <= 1048576),
    revision BIGINT NOT NULL CHECK(revision > 0)
);
CREATE TABLE custom_emoji_codes (
    code TEXT PRIMARY KEY,
    emoji_id TEXT NOT NULL REFERENCES custom_emojis(id) ON DELETE CASCADE
);
