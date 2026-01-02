-- HDHomeRun Emulator Support
-- Enables Hermes to act as an HDHomeRun tuner for Plex integration

-- HDHomeRun channel mappings (which channels to expose to Plex)
CREATE TABLE IF NOT EXISTS hdhr_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER NOT NULL,
    guide_number TEXT NOT NULL,
    guide_name TEXT,
    enabled INTEGER DEFAULT 1,
    sort_order INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE,
    UNIQUE(guide_number)
);

-- Category auto-include rules (for bulk channel selection)
CREATE TABLE IF NOT EXISTS hdhr_category_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER,
    category_pattern TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    auto_number_start INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_hdhr_channels_media ON hdhr_channels(media_id);
CREATE INDEX IF NOT EXISTS idx_hdhr_channels_enabled ON hdhr_channels(enabled);
CREATE INDEX IF NOT EXISTS idx_hdhr_channels_guide ON hdhr_channels(guide_number);
CREATE INDEX IF NOT EXISTS idx_hdhr_category_rules_source ON hdhr_category_rules(source_id);
