-- Add unique index on (source_id, external_id) to properly support multiple IPTV sources
-- First, remove duplicates keeping the one with the best data (has TMDB poster or highest ID)

DELETE FROM media
WHERE id NOT IN (
    SELECT MIN(CASE WHEN poster LIKE '%image.tmdb.org%' THEN id ELSE id + 1000000000 END)
    FROM media
    GROUP BY source_id, external_id
);

-- Now create unique index
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_source_external
ON media(source_id, external_id);

-- Also add unique index for episodes
CREATE UNIQUE INDEX IF NOT EXISTS idx_episodes_media_external
ON episodes(media_id, external_id);
