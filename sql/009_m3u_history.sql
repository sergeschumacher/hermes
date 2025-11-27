-- M3U history table - stores last 5 M3U files per source
-- Useful for debugging and rollback if a sync corrupts data

CREATE TABLE IF NOT EXISTS m3u_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    channel_count INTEGER DEFAULT 0,
    file_size INTEGER DEFAULT 0,
    fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
);

-- Index for efficient querying by source and time
CREATE INDEX IF NOT EXISTS idx_m3u_history_source ON m3u_history(source_id);
CREATE INDEX IF NOT EXISTS idx_m3u_history_fetched ON m3u_history(fetched_at);
