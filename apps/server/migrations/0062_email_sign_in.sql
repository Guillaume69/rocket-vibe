-- A verified address signs in only while no other account holds it. Earlier
-- duplicates stay contacts, none of them a sign-in identifier.
ALTER TABLE account_emails ADD COLUMN sign_in boolean NOT NULL DEFAULT true;
UPDATE account_emails e SET sign_in=false
WHERE EXISTS (SELECT 1 FROM account_emails o WHERE o.address=e.address AND o.user_id<>e.user_id);
CREATE UNIQUE INDEX account_emails_sign_in ON account_emails(address) WHERE sign_in;
