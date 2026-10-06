ALTER TABLE messages ADD COLUMN cards JSONB NOT NULL DEFAULT '[]';
ALTER TABLE messages ADD CONSTRAINT message_cards_array CHECK (
    jsonb_typeof(cards) = 'array' AND jsonb_array_length(cards) <= 3
);
ALTER TABLE messages ADD COLUMN cards_search_vector TSVECTOR
    GENERATED ALWAYS AS (jsonb_to_tsvector('simple'::regconfig,
        CASE WHEN deleted OR system IS NOT NULL THEN '[]'::jsonb ELSE cards END,
        '["string"]'::jsonb)) STORED;
CREATE INDEX messages_cards_search ON messages USING GIN(cards_search_vector)
    WHERE NOT deleted AND system IS NULL;
