-- LLM Integration Support
-- Adds channel mappings table and translated title tracking

-- Store AI-generated channel mappings between EPG and IPTV sources
CREATE TABLE IF NOT EXISTS channel_mappings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    epg_channel_id TEXT NOT NULL,           -- e.g., "rtl2.de"
    source_channel_name TEXT NOT NULL,      -- e.g., "RTL Zwei"
    source_id INTEGER,                      -- Reference to sources table
    confidence REAL DEFAULT 0.0,            -- AI confidence score (0-1)
    verified INTEGER DEFAULT 0,             -- User-verified flag
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(epg_channel_id, source_id)
);

-- Index for quick lookups
CREATE INDEX IF NOT EXISTS idx_channel_mappings_epg ON channel_mappings(epg_channel_id);
CREATE INDEX IF NOT EXISTS idx_channel_mappings_source ON channel_mappings(source_channel_name);

-- Add translated title tracking to media table
-- translated_title: The English title returned by LLM
-- translation_source: Which LLM provider was used ('openai' or 'ollama')
ALTER TABLE media ADD COLUMN translated_title TEXT;
ALTER TABLE media ADD COLUMN translation_source TEXT
