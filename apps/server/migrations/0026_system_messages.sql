ALTER TABLE messages ADD COLUMN system JSONB;
ALTER TABLE messages ADD CONSTRAINT system_message_no_user_content
    CHECK (system IS NULL OR (text = '' AND quote_references = '[]'::jsonb AND NOT deleted));
