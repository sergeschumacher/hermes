-- Transcode queue for post-download video conversion
CREATE TABLE IF NOT EXISTS transcode_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    download_id INTEGER NOT NULL,
    input_path TEXT NOT NULL,
    final_dir TEXT NOT NULL,
    filename TEXT NOT NULL,
    media_type TEXT,
    status TEXT DEFAULT 'pending',  -- pending, transcoding, completed, failed, skipped
    progress INTEGER DEFAULT 0,
    duration INTEGER,               -- Video duration in seconds (for progress calc)
    error_message TEXT,
    started_at DATETIME,
    completed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_transcode_status ON transcode_queue(status);
CREATE INDEX IF NOT EXISTS idx_transcode_download ON transcode_queue(download_id);
