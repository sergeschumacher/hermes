-- EPG Channel Cache for performance
-- Migration 022

-- Cache table to store filtered EPG channels with IPTV availability
CREATE TABLE IF NOT EXISTS epg_channel_cache (
    channel_id TEXT PRIMARY KEY,
    country TEXT,
    language TEXT,
    has_iptv_source INTEGER DEFAULT 0,
    iptv_media_ids TEXT,  -- JSON array of matching media IDs
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Index for quick lookups
CREATE INDEX IF NOT EXISTS idx_epg_cache_language ON epg_channel_cache(language);
CREATE INDEX IF NOT EXISTS idx_epg_cache_has_source ON epg_channel_cache(has_iptv_source);
