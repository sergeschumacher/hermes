-- EPG (Electronic Program Guide) Support

-- Add EPG URL field to sources
ALTER TABLE sources ADD COLUMN epg_url TEXT;

-- Add tvg_id to media for EPG channel matching
ALTER TABLE media ADD COLUMN tvg_id TEXT;

-- EPG Programs table
CREATE TABLE IF NOT EXISTS epg_programs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,           -- tvg-id from XMLTV
    source_id INTEGER,                  -- Which source this EPG belongs to
    title TEXT NOT NULL,
    subtitle TEXT,                      -- Episode title or sub-title
    description TEXT,
    category TEXT,                      -- Genre/category from EPG
    start_time DATETIME NOT NULL,
    end_time DATETIME NOT NULL,
    icon TEXT,                          -- Program poster/icon
    episode_num TEXT,                   -- Episode number (e.g., "S01E01")
    rating TEXT,                        -- Content rating
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
);

-- Indexes for fast EPG queries
CREATE INDEX IF NOT EXISTS idx_epg_channel ON epg_programs(channel_id);
CREATE INDEX IF NOT EXISTS idx_epg_source ON epg_programs(source_id);
CREATE INDEX IF NOT EXISTS idx_epg_start ON epg_programs(start_time);
CREATE INDEX IF NOT EXISTS idx_epg_end ON epg_programs(end_time);
CREATE INDEX IF NOT EXISTS idx_epg_channel_time ON epg_programs(channel_id, start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_media_tvg ON media(tvg_id);

-- EPG sync metadata
CREATE TABLE IF NOT EXISTS epg_sync (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER UNIQUE,
    last_sync DATETIME,
    program_count INTEGER DEFAULT 0,
    channel_count INTEGER DEFAULT 0,
    FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
);
