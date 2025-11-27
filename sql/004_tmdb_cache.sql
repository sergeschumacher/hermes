-- TMDB API response cache table
CREATE TABLE IF NOT EXISTS tmdb_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cache_key TEXT UNIQUE NOT NULL,
    cache_type TEXT NOT NULL,  -- 'movie', 'tv', 'season', 'person', 'search_movie', 'search_tv'
    tmdb_id INTEGER,
    data TEXT NOT NULL,  -- JSON response
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL
);

-- Index for cache lookups
CREATE INDEX IF NOT EXISTS idx_tmdb_cache_key ON tmdb_cache(cache_key);
CREATE INDEX IF NOT EXISTS idx_tmdb_cache_expires ON tmdb_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_tmdb_cache_type ON tmdb_cache(cache_type);
