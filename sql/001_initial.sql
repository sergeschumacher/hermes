-- IPTV Sources
CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT DEFAULT 'xtream',
    url TEXT NOT NULL,
    username TEXT,
    password TEXT,
    user_agent TEXT DEFAULT 'IBOPlayer',
    active INTEGER DEFAULT 1,
    last_sync DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Media Content
CREATE TABLE IF NOT EXISTS media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER,
    external_id TEXT,
    media_type TEXT NOT NULL,
    title TEXT NOT NULL,
    original_title TEXT,
    year INTEGER,
    plot TEXT,
    poster TEXT,
    backdrop TEXT,
    rating REAL,
    runtime INTEGER,
    genres TEXT,
    language TEXT,
    quality TEXT,
    container TEXT,
    stream_url TEXT,
    category TEXT,
    tmdb_id INTEGER,
    imdb_id TEXT,
    last_updated DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
);

-- Series Episodes
CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER NOT NULL,
    external_id TEXT,
    season INTEGER,
    episode INTEGER,
    title TEXT,
    plot TEXT,
    air_date TEXT,
    runtime INTEGER,
    stream_url TEXT,
    container TEXT,
    FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
);

-- People (Actors/Directors)
CREATE TABLE IF NOT EXISTS people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tmdb_id INTEGER UNIQUE,
    name TEXT NOT NULL,
    profile_path TEXT,
    biography TEXT,
    birthday TEXT,
    place_of_birth TEXT,
    known_for TEXT
);

-- Media-People relationships
CREATE TABLE IF NOT EXISTS media_people (
    media_id INTEGER NOT NULL,
    person_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    character TEXT,
    credit_order INTEGER,
    PRIMARY KEY (media_id, person_id, role),
    FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE,
    FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE
);

-- Download Queue
CREATE TABLE IF NOT EXISTS downloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER,
    episode_id INTEGER,
    status TEXT DEFAULT 'queued',
    progress REAL DEFAULT 0,
    file_size INTEGER,
    downloaded_size INTEGER DEFAULT 0,
    temp_path TEXT,
    final_path TEXT,
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    overseerr_request_id TEXT,
    started_at DATETIME,
    completed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE SET NULL,
    FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE SET NULL
);

-- Create indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_media_type ON media(media_type);
CREATE INDEX IF NOT EXISTS idx_media_title ON media(title);
CREATE INDEX IF NOT EXISTS idx_media_year ON media(year);
CREATE INDEX IF NOT EXISTS idx_media_tmdb ON media(tmdb_id);
CREATE INDEX IF NOT EXISTS idx_media_source ON media(source_id);
CREATE INDEX IF NOT EXISTS idx_episodes_media ON episodes(media_id);
CREATE INDEX IF NOT EXISTS idx_downloads_status ON downloads(status);
CREATE INDEX IF NOT EXISTS idx_media_people_media ON media_people(media_id);
CREATE INDEX IF NOT EXISTS idx_media_people_person ON media_people(person_id);
