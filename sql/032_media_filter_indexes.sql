-- Indexes to speed up filter and listing queries
CREATE INDEX IF NOT EXISTS idx_media_language ON media(language);
CREATE INDEX IF NOT EXISTS idx_media_quality ON media(quality);
CREATE INDEX IF NOT EXISTS idx_media_category ON media(category);
CREATE INDEX IF NOT EXISTS idx_media_created_at ON media(created_at);
CREATE INDEX IF NOT EXISTS idx_media_rating ON media(rating);
CREATE INDEX IF NOT EXISTS idx_media_genres ON media(genres);
