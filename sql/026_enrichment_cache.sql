-- Enrichment cache table - persists TMDB data across provider changes
-- Keyed by normalized title + year + media_type
CREATE TABLE IF NOT EXISTS enrichment_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cache_key TEXT UNIQUE NOT NULL,  -- normalized_title|year|media_type
    media_type TEXT NOT NULL,        -- 'movie' or 'series'
    title TEXT NOT NULL,             -- original title for reference
    year INTEGER,
    tmdb_id INTEGER,
    poster TEXT,
    backdrop TEXT,
    rating REAL,
    plot TEXT,
    tagline TEXT,
    genres TEXT,                     -- JSON array
    runtime INTEGER,
    imdb_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_enrichment_cache_key ON enrichment_cache(cache_key);
CREATE INDEX IF NOT EXISTS idx_enrichment_cache_tmdb ON enrichment_cache(tmdb_id);
