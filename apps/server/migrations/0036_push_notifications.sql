-- Registration follows a session family, so renewing an opaque bearer does not
-- remove the device. Logout / device revocation cascades to deliveries.
CREATE TABLE push_devices (
    device_id text PRIMARY KEY REFERENCES session_devices(id) ON DELETE CASCADE,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    data_epoch text NOT NULL,
    token text NOT NULL CHECK (octet_length(token) BETWEEN 1 AND 4096),
    generation text NOT NULL DEFAULT gen_random_uuid()::text,
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_devices_user ON push_devices(user_id);

-- One stable notification per original message / device. No chat text or bearer
-- is stored in the queue. Replays preserve its identity, including after a crash.
CREATE TABLE push_notifications (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    device_id text NOT NULL REFERENCES push_devices(device_id) ON DELETE CASCADE,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    data_epoch text NOT NULL,
    generation text NOT NULL,
    membership_version text NOT NULL,
    activation_version text NOT NULL,
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','delivered','retired')),
    attempts integer NOT NULL DEFAULT 0,
    available_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT now()+interval '1 day',
    lease_id text,
    lease_expires_at timestamptz,
    UNIQUE(message_id,device_id)
);
CREATE INDEX push_notifications_pending ON push_notifications(available_at) WHERE state='pending';
CREATE INDEX push_notifications_expiry ON push_notifications(expires_at);

-- Shared by transactional capture, workers and private content reads. Recipients
-- of @here were already frozen by message_mentions in the send transaction.
CREATE VIEW eligible_push_recipients AS
SELECT d.device_id,d.user_id,d.generation,d.token,i.instance_id,i.data_epoch,
       s.membership_version,u.activation_version,m.id AS message_id,
       m.room_id,m.reply_to,m.revision
FROM push_devices d
JOIN users u ON u.id=d.user_id
JOIN instance i ON i.singleton AND i.data_epoch=d.data_epoch
JOIN sessions a ON a.device_id=d.device_id AND a.user_id=d.user_id AND a.expires_at>now()
JOIN room_read_states s ON s.user_id=d.user_id
JOIN messages m ON m.room_id=s.room_id AND m.author_id<>d.user_id
JOIN rooms r ON r.id=m.room_id
WHERE NOT u.disabled AND u.push_enabled AND u.chosen_status<>'busy'
  AND NOT m.deleted AND m.system IS NULL
  AND (NOT u.push_mentions_only OR r.kind='direct'
       OR EXISTS(SELECT 1 FROM message_mentions x WHERE x.message_id=m.id AND x.user_id=d.user_id))
  AND ((m.reply_to IS NULL AND m.position>s.root_position)
       OR (m.reply_to IS NOT NULL AND m.position>GREATEST(s.reply_position,
           COALESCE((SELECT t.position FROM thread_read_states t WHERE t.root_id=m.reply_to AND t.user_id=d.user_id),0))))
  AND NOT EXISTS(SELECT 1 FROM presence_leases p JOIN sessions ps ON ps.device_id=p.device_id
      WHERE p.user_id=d.user_id AND p.data_epoch=i.data_epoch AND p.expires_at>now()
        AND ps.expires_at>now() AND p.status IN ('online','busy'));
