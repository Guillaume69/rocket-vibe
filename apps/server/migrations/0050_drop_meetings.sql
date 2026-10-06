-- Jitsi meetings are retired from the native server: voice sessions replace
-- them (0049). call_started rows keep their meeting_id as an opaque parameter.
DROP TABLE meeting_operations;
DROP TABLE meetings;
