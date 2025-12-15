-- Migration 025: Fix media classification and add platform column
-- This migration fixes misclassified movies/series and adds streaming platform extraction

-- Add platform column for streaming service filtering
ALTER TABLE media ADD COLUMN platform TEXT;

-- Create index for platform filtering
CREATE INDEX IF NOT EXISTS idx_media_platform ON media(platform);

-- Create index for media_type filtering (if not exists)
CREATE INDEX IF NOT EXISTS idx_media_type ON media(media_type);

-- Fix series (SRS prefix) - these were incorrectly classified as 'live'
UPDATE media SET media_type = 'series'
WHERE media_type = 'live'
AND (category LIKE 'SRS -%' OR category LIKE 'SRS-%');

-- Fix movies (VOD prefix) - these were incorrectly classified as 'live'
UPDATE media SET media_type = 'movie'
WHERE media_type = 'live'
AND (category LIKE 'VOD -%' OR category LIKE 'VOD-%');

-- Fix remaining movies by keywords
UPDATE media SET media_type = 'movie'
WHERE media_type = 'live'
AND (category LIKE '%CINEMA%' OR category LIKE '%FILM %' OR category LIKE '%BIOSCOOP%' OR category LIKE '%KINO%');

-- Fix remaining series by keywords
UPDATE media SET media_type = 'series'
WHERE media_type = 'live'
AND (category LIKE '%SERIE%' OR category LIKE '%SOROZAT%' OR category LIKE '%SERIALE%');

-- Backfill platform data for existing items
UPDATE media SET platform = 'NETFLIX' WHERE category LIKE '%NETFLIX%' AND platform IS NULL;
UPDATE media SET platform = 'AMAZON' WHERE (category LIKE '%PRIME+%' OR category LIKE '%PRIME %' OR category LIKE '%AMAZON%') AND platform IS NULL;
UPDATE media SET platform = 'DISNEY+' WHERE category LIKE '%DISNEY%' AND platform IS NULL;
UPDATE media SET platform = 'HBO' WHERE category LIKE '%HBO%' AND platform IS NULL;
UPDATE media SET platform = 'APPLE TV' WHERE category LIKE '%APPLE%' AND platform IS NULL;
UPDATE media SET platform = 'PARAMOUNT+' WHERE category LIKE '%PARAMOUNT%' AND platform IS NULL;
UPDATE media SET platform = 'HULU' WHERE category LIKE '%HULU%' AND platform IS NULL;
UPDATE media SET platform = 'CANAL+' WHERE category LIKE '%CANAL%' AND platform IS NULL;
UPDATE media SET platform = 'MOVISTAR+' WHERE category LIKE '%MOVISTAR%' AND platform IS NULL;
UPDATE media SET platform = 'SKY' WHERE category LIKE '%SKY %' AND platform IS NULL;
UPDATE media SET platform = 'DAZN' WHERE category LIKE '%DAZN%' AND platform IS NULL;
