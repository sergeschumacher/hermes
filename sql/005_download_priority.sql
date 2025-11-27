-- Add priority column to downloads table
-- Higher priority = processed first (100 = highest, 0 = lowest)
ALTER TABLE downloads ADD COLUMN priority INTEGER DEFAULT 50;

-- Add index for efficient queue ordering
CREATE INDEX IF NOT EXISTS idx_downloads_queue ON downloads(status, priority DESC, created_at ASC);
