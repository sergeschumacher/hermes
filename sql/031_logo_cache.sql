-- Logo Cache Support
-- Stores local path to cached channel logos that persist across EPG refreshes

-- Add cached_logo column to media table for Live TV channels
ALTER TABLE media ADD COLUMN cached_logo TEXT;

-- Index for quick logo lookups
CREATE INDEX IF NOT EXISTS idx_media_cached_logo ON media(cached_logo) WHERE cached_logo IS NOT NULL;
