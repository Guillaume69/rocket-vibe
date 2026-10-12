-- Bind creation receipts to the acting administrator; store only token hashes.
ALTER TABLE account_invitations ADD COLUMN issued_by text REFERENCES users(id);
ALTER TABLE account_invitations ADD COLUMN operation_id text;
CREATE UNIQUE INDEX account_invitations_admin_operation ON account_invitations(issued_by,operation_id)
    WHERE issued_by IS NOT NULL;
