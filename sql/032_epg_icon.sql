-- EPG Icon column for fallback logo support
-- Migration 032

-- Add epg_icon column to store channel icon URL from EPG separately from M3U poster
ALTER TABLE media ADD COLUMN epg_icon TEXT;
