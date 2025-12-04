-- Add missing columns and indexes that code expects
-- Note: SQLite doesn't support IF NOT EXISTS for ALTER TABLE, so we check with pragma

-- Add unique indexes (these are safe with IF NOT EXISTS)
CREATE UNIQUE INDEX IF NOT EXISTS idx_episodes_season_ep ON episodes(media_id, season, episode);
CREATE UNIQUE INDEX IF NOT EXISTS idx_episodes_media_external ON episodes(media_id, external_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_source_external ON media(source_id, external_id);
