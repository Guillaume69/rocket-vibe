-- Encrypted edits and deletions (E2EE_AMENDMENTS.md): the amended message, from
-- the routing header. Only an accepted message of the same room by the same
-- author, never another amendment, can be amended.
ALTER TABLE e2ee_application_messages ADD COLUMN target TEXT REFERENCES e2ee_application_messages(id);
