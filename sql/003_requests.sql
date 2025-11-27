-- Requests table for Overseerr integration
CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tmdb_id INTEGER,
    media_type TEXT NOT NULL,
    title TEXT NOT NULL,
    year INTEGER,
    poster TEXT,
    status TEXT DEFAULT 'pending',
    source TEXT DEFAULT 'overseerr',
    requested_by TEXT,
    matched_media_id INTEGER,
    approved_at DATETIME,
    rejected_at DATETIME,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (matched_media_id) REFERENCES media(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_tmdb ON requests(tmdb_id);
