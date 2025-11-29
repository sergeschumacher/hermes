-- Scheduler and Recordings Support
-- Migration 012

-- Scheduled recordings table
CREATE TABLE IF NOT EXISTS scheduled_recordings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER NOT NULL,          -- Live TV channel media ID
    title TEXT NOT NULL,                -- Recording title (program name)
    channel_name TEXT,                  -- Channel display name
    start_time DATETIME NOT NULL,       -- When to start recording
    end_time DATETIME NOT NULL,         -- When to stop recording
    status TEXT DEFAULT 'scheduled',    -- scheduled, recording, completed, failed, cancelled
    recurrence TEXT,                    -- null=once, daily, weekly, weekdays
    epg_program_id INTEGER,             -- Link to EPG program if scheduled from EPG
    output_path TEXT,                   -- Where recording was saved
    file_size INTEGER,                  -- Size of recording in bytes
    error_message TEXT,
    pid INTEGER,                        -- Process ID when recording
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
);

-- Scheduler tasks table (for general scheduled tasks)
CREATE TABLE IF NOT EXISTS scheduler_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_type TEXT NOT NULL,            -- epg_sync, source_sync, cleanup, recording
    task_data TEXT,                     -- JSON data for the task
    next_run DATETIME NOT NULL,
    interval_minutes INTEGER,           -- Repeat interval (null = one-time)
    last_run DATETIME,
    status TEXT DEFAULT 'active',       -- active, paused, completed
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for recordings
CREATE INDEX IF NOT EXISTS idx_recordings_status ON scheduled_recordings(status);
CREATE INDEX IF NOT EXISTS idx_recordings_start ON scheduled_recordings(start_time);
CREATE INDEX IF NOT EXISTS idx_recordings_media ON scheduled_recordings(media_id);

-- Indexes for scheduler
CREATE INDEX IF NOT EXISTS idx_scheduler_next ON scheduler_tasks(next_run);
CREATE INDEX IF NOT EXISTS idx_scheduler_status ON scheduler_tasks(status);
CREATE INDEX IF NOT EXISTS idx_scheduler_type ON scheduler_tasks(task_type);

-- Make EPG global (remove source_id dependency)
-- We keep source_id in epg_programs for backwards compatibility but don't require it
-- New EPG entries will have source_id = NULL (global)

-- Add country field to epg_programs for global EPG
ALTER TABLE epg_programs ADD COLUMN country TEXT;

-- Index for country-based EPG queries
CREATE INDEX IF NOT EXISTS idx_epg_country ON epg_programs(country);
