-- Source Pattern Analyzer migration
-- Adds analysis metadata to sources and creates sample storage table

-- Add analysis metadata columns to sources table
ALTER TABLE sources ADD COLUMN analysis_status TEXT DEFAULT NULL;
ALTER TABLE sources ADD COLUMN last_analyzed DATETIME;
ALTER TABLE sources ADD COLUMN analysis_confidence REAL;

-- Store raw samples for re-analysis
CREATE TABLE IF NOT EXISTS source_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL,
    content_type TEXT NOT NULL,  -- 'movie', 'series', 'live'
    raw_extinf TEXT NOT NULL,
    raw_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
);

-- Index for efficient lookups by source
CREATE INDEX IF NOT EXISTS idx_source_samples_source ON source_samples(source_id);
