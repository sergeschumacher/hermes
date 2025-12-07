-- Background enrichment job queue for parallel processing
CREATE TABLE IF NOT EXISTS enrichment_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER NOT NULL,
    priority INTEGER DEFAULT 0,  -- Higher = more urgent
    status TEXT DEFAULT 'pending',  -- pending, processing, completed, failed
    worker_id TEXT,  -- Which worker is processing
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    started_at DATETIME,
    completed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_enrich_queue_status ON enrichment_queue(status);
CREATE INDEX IF NOT EXISTS idx_enrich_queue_priority ON enrichment_queue(priority DESC, created_at ASC);

-- Prevent duplicate pending/processing entries for same media
CREATE UNIQUE INDEX IF NOT EXISTS idx_enrich_queue_media_pending ON enrichment_queue(media_id)
    WHERE status IN ('pending', 'processing');
