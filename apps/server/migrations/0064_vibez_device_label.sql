ALTER TABLE session_devices ALTER COLUMN label SET DEFAULT 'Vibez';
UPDATE session_devices SET label='Vibez' WHERE label='RocketVibe';
