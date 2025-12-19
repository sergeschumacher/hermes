-- Usenet/Newsgroup Support Migration
-- Adds usenet providers and NZB download tracking

-- Usenet providers (NNTP servers for downloading)
CREATE TABLE IF NOT EXISTS usenet_providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER DEFAULT 563,
    ssl INTEGER DEFAULT 1,
    username TEXT,
    password TEXT,
    connections INTEGER DEFAULT 10,
    priority INTEGER DEFAULT 0,
    enabled INTEGER DEFAULT 1,
    retention_days INTEGER DEFAULT 3000,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- NZB download tracking (extends downloads table)
CREATE TABLE IF NOT EXISTS nzb_downloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    download_id INTEGER NOT NULL,
    nzb_name TEXT,
    nzb_content TEXT,
    total_files INTEGER DEFAULT 0,
    completed_files INTEGER DEFAULT 0,
    total_segments INTEGER DEFAULT 0,
    completed_segments INTEGER DEFAULT 0,
    failed_segments INTEGER DEFAULT 0,
    total_bytes INTEGER DEFAULT 0,
    downloaded_bytes INTEGER DEFAULT 0,
    par2_status TEXT DEFAULT 'pending',
    extract_status TEXT DEFAULT 'pending',
    temp_path TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE CASCADE
);

-- Individual segment tracking for resumable downloads
CREATE TABLE IF NOT EXISTS nzb_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nzb_download_id INTEGER NOT NULL,
    file_name TEXT NOT NULL,
    file_index INTEGER NOT NULL,
    segment_number INTEGER NOT NULL,
    message_id TEXT NOT NULL,
    bytes INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending',
    provider_id INTEGER,
    error_message TEXT,
    attempts INTEGER DEFAULT 0,
    FOREIGN KEY (nzb_download_id) REFERENCES nzb_downloads(id) ON DELETE CASCADE,
    FOREIGN KEY (provider_id) REFERENCES usenet_providers(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_nzb_segments_status ON nzb_segments(nzb_download_id, status);
CREATE INDEX IF NOT EXISTS idx_nzb_segments_msgid ON nzb_segments(message_id);
CREATE INDEX IF NOT EXISTS idx_nzb_segments_file ON nzb_segments(nzb_download_id, file_index, segment_number);

-- Extend sources table for newznab indexers
-- type = 'newznab' for indexers
-- indexer_config JSON: { apiKey, categories, searchTypes, rssUrl }
ALTER TABLE sources ADD COLUMN indexer_config TEXT;

-- Extend downloads table for usenet downloads
ALTER TABLE downloads ADD COLUMN nzb_url TEXT;
ALTER TABLE downloads ADD COLUMN nzb_title TEXT;
ALTER TABLE downloads ADD COLUMN source_type TEXT DEFAULT 'iptv';
