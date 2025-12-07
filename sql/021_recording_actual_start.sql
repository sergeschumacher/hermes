-- Recording actual start time
-- Migration 021

-- Add column to track when recording actually started (vs scheduled start)
ALTER TABLE scheduled_recordings ADD COLUMN actual_start_time DATETIME;
