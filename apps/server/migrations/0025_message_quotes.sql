-- References only. A quoted source's text is resolved for the current reader.
ALTER TABLE messages ADD COLUMN quote_references JSONB NOT NULL DEFAULT '[]'
    CHECK (jsonb_typeof(quote_references)='array' AND jsonb_array_length(quote_references)<=8);
