-- Encrypted files of private rooms (E2EE_FILES.md): an opaque object whose
-- reservation the private message completes, never an ordinary message.
ALTER TABLE uploads ADD COLUMN encrypted boolean NOT NULL DEFAULT false;
ALTER TABLE uploads ADD COLUMN e2ee_message_id text REFERENCES e2ee_application_messages(id);
ALTER TABLE uploads DROP CONSTRAINT uploads_check;
ALTER TABLE uploads ADD CONSTRAINT uploads_completed_link CHECK (
 (state='completed')=(message_id IS NOT NULL OR e2ee_message_id IS NOT NULL)
 AND (message_id IS NULL OR e2ee_message_id IS NULL)
 AND (e2ee_message_id IS NULL OR encrypted)
 AND (message_id IS NULL OR NOT encrypted)
);
CREATE INDEX uploads_e2ee_message ON uploads(e2ee_message_id) WHERE e2ee_message_id IS NOT NULL;
