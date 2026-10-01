-- Counters belong only to the disposable fixture; no bearer or hash is selected.
DO $$
DECLARE account TEXT;
BEGIN
    FOREACH account IN ARRAY ARRAY['mobile','desktop'] LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pilot_seen_session_devices d JOIN users u ON u.id=d.user_id
            WHERE u.username=account AND d.renewals>0
        ) THEN
            RAISE EXCEPTION 'The real % client did not renew its initial short bearer',account;
        END IF;
    END LOOP;
END;
$$;
SELECT u.username,SUM(d.renewals) AS completed_renewals
FROM pilot_seen_session_devices d JOIN users u ON u.id=d.user_id
GROUP BY u.username ORDER BY u.username;
