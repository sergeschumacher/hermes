-- Add player simulation/throttling settings per source
-- This makes downloads look like a user watching content rather than bulk downloading

-- Per-source throttle settings
-- simulate_playback: 1 = enabled (throttle to simulate watching), 0 = disabled (full speed)
-- playback_speed_multiplier: Download at this multiple of video bitrate
--   1.0 = exactly playback speed (might buffer)
--   1.5 = 50% faster than playback (safe margin for buffering)
--   2.0 = 2x playback speed
--   0 = disabled, full speed

ALTER TABLE sources ADD COLUMN simulate_playback INTEGER DEFAULT 1;

ALTER TABLE sources ADD COLUMN playback_speed_multiplier REAL DEFAULT 1.5;
