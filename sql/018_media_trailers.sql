-- Add tagline column to media table
ALTER TABLE media ADD COLUMN tagline TEXT;

-- Create trailers table for storing YouTube trailer URLs
CREATE TABLE IF NOT EXISTS media_trailers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER NOT NULL,
    youtube_key TEXT NOT NULL,
    name TEXT,
    type TEXT,  -- 'Trailer', 'Teaser', 'Clip', 'Featurette'
    official INTEGER DEFAULT 0,
    published_at TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE,
    UNIQUE(media_id, youtube_key)
);

CREATE INDEX IF NOT EXISTS idx_trailers_media ON media_trailers(media_id);
CREATE INDEX IF NOT EXISTS idx_trailers_type ON media_trailers(type);
