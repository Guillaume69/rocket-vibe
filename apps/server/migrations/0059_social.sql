CREATE TABLE social_cards (message_id text PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, author_id text NOT NULL REFERENCES users(id), definition jsonb NOT NULL, closed boolean NOT NULL DEFAULT false);
CREATE TABLE social_answers (message_id text NOT NULL REFERENCES social_cards(message_id) ON DELETE CASCADE, user_id text NOT NULL REFERENCES users(id), choices jsonb NOT NULL, PRIMARY KEY(message_id,user_id));
CREATE TABLE sticker_shelf (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, name text NOT NULL, url text NOT NULL, UNIQUE(user_id,url));
CREATE TABLE voice_reactions (id text PRIMARY KEY, room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, emoji text NOT NULL, expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '6 seconds');
CREATE INDEX voice_reactions_expiry ON voice_reactions(expires_at);
ALTER TABLE messages ADD COLUMN social jsonb;
