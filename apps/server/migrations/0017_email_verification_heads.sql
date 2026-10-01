-- A claimed command head survives pruning its temporary challenge row.
-- Only explicit retirement or accepted verification opens a new head.
ALTER TABLE session_devices ADD COLUMN email_verification_claimed boolean NOT NULL DEFAULT false;
UPDATE session_devices d SET email_verification_claimed=true
WHERE EXISTS (
  SELECT 1 FROM email_verifications v
  WHERE v.device_id=d.id AND v.requested_version=d.email_verification_version
);
