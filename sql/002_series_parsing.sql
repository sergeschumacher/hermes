-- Add parsed series fields to media table
ALTER TABLE media ADD COLUMN show_name TEXT;
ALTER TABLE media ADD COLUMN season_number INTEGER;
ALTER TABLE media ADD COLUMN episode_number INTEGER;
ALTER TABLE media ADD COLUMN show_language TEXT;

-- Create index for show grouping
CREATE INDEX IF NOT EXISTS idx_media_show_name ON media(show_name);
CREATE INDEX IF NOT EXISTS idx_media_show_lang ON media(show_language);
