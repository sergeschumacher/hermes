-- Add is_active flag and last_seen_at timestamp for smart sync
-- Items removed from source will be marked inactive instead of deleted
-- This preserves enrichment data in case items return

ALTER TABLE media ADD COLUMN is_active INTEGER DEFAULT 1;
ALTER TABLE media ADD COLUMN last_seen_at DATETIME;

-- Index for efficient filtering of active items
CREATE INDEX IF NOT EXISTS idx_media_is_active ON media(is_active);
CREATE INDEX IF NOT EXISTS idx_media_last_seen ON media(last_seen_at);

-- Set all existing items as active with current timestamp
UPDATE media SET is_active = 1, last_seen_at = CURRENT_TIMESTAMP WHERE is_active IS NULL;
