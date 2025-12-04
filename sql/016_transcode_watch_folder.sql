-- Allow manual transcodes without download_id (for watch folder feature)
-- SQLite doesn't support ALTER COLUMN, so we need to recreate the table

-- Create new table with nullable download_id
CREATE TABLE IF NOT EXISTS transcode_queue_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    download_id INTEGER,              -- NULL for manual/watch folder transcodes
    input_path TEXT NOT NULL,
    final_dir TEXT NOT NULL,
    filename TEXT NOT NULL,
    media_type TEXT,
    source TEXT DEFAULT 'download',   -- 'download' or 'watch' to track origin
    status TEXT DEFAULT 'pending',    -- pending, transcoding, completed, failed, skipped
    progress INTEGER DEFAULT 0,
    duration INTEGER,
    error_message TEXT,
    started_at DATETIME,
    completed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE CASCADE
);

-- Copy existing data
INSERT INTO transcode_queue_new (id, download_id, input_path, final_dir, filename, media_type, source, status, progress, duration, error_message, started_at, completed_at, created_at)
SELECT id, download_id, input_path, final_dir, filename, media_type, 'download', status, progress, duration, error_message, started_at, completed_at, created_at
FROM transcode_queue;

-- Drop old table and rename new one
DROP TABLE transcode_queue;
ALTER TABLE transcode_queue_new RENAME TO transcode_queue;

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_transcode_status ON transcode_queue(status);
CREATE INDEX IF NOT EXISTS idx_transcode_download ON transcode_queue(download_id);
CREATE INDEX IF NOT EXISTS idx_transcode_source ON transcode_queue(source);
