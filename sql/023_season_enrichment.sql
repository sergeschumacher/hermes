-- Season enrichment support
-- Adds seasons table for TMDB season data and extends episodes table

-- Create seasons table to store TMDB season metadata
CREATE TABLE IF NOT EXISTS seasons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER NOT NULL,
    tmdb_id INTEGER,
    season_number INTEGER NOT NULL,
    name TEXT,
    overview TEXT,
    poster TEXT,
    air_date TEXT,
    episode_count INTEGER,
    vote_average REAL,
    FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_seasons_media ON seasons(media_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_seasons_media_num ON seasons(media_id, season_number);

-- Add TMDB enrichment columns to episodes table
ALTER TABLE episodes ADD COLUMN tmdb_id INTEGER;
ALTER TABLE episodes ADD COLUMN still_path TEXT;
ALTER TABLE episodes ADD COLUMN vote_average REAL;
ALTER TABLE episodes ADD COLUMN vote_count INTEGER;
ALTER TABLE episodes ADD COLUMN overview TEXT;

-- Add number_of_seasons and number_of_episodes to media table for TV shows
ALTER TABLE media ADD COLUMN number_of_seasons INTEGER;
ALTER TABLE media ADD COLUMN number_of_episodes INTEGER;
